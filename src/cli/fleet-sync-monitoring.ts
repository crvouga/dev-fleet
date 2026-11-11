import type { FleetNode, Runner, Check } from '../types';
import type { FleetDefinition } from '../definition';
import { hubUrl, roleOf } from '../topology';
import { discoverTailnet } from '../tailscale';
import { fleetIdentity, hubAccess } from '../monitoring/hub-access';
import { enrollBeszel } from '../monitoring/enroll';
import { verifyBeszel } from '../monitoring/beszel';
import { installRemoteAgent } from '../monitoring/remote';
import { installManagerAgent } from '../monitoring/manager-agent';

export interface MonitoringDependencies {
  access?: typeof hubAccess;
  sampleDeadlineMs?: number;
}

/** Enrolls one worker's Beszel agent against the manager's hub. Workers never
 * host the hub; it is converged on the manager by convergeManagerHub. Called
 * after source bootstrap, only under approved manager application.
 */
export function synchronizeMonitoringWith(
  dependencies: MonitoringDependencies = {}
) {
  return async function synchronize(
    node: FleetNode,
    definition: FleetDefinition,
    revision: string,
    run: Runner
  ): Promise<Check[]> {
    try {
      return await enrollWorker(node, definition, {
        revision,
        run,
        ...dependencies,
      });
    } catch (error) {
      return unavailable(errorCode(error));
    }
  };
}
export const synchronizeMonitoring = synchronizeMonitoringWith();

/** The manager is always a monitored system on its own hub: after the hub
 * converges, fleet-sync enrolls the manager like a worker, but installs its
 * agent locally as a per-user launch agent (no SSH, no sudo).
 */
export async function enrollManagerMonitoring(
  definition: FleetDefinition,
  workspace: string,
  run: Runner,
  dependencies: MonitoringDependencies & {
    install?: typeof installManagerAgent;
  } = {}
): Promise<Check[]> {
  const { manager } = definition;
  try {
    const hub = hubUrl(definition);
    if (!(await hubReachable(hub, run)))
      return unavailable('BESZEL_HUB_UNREACHABLE');
    const access = await (dependencies.access ?? hubAccess)(hub);
    const enrollment = await enrollBeszel(
      {
        node: manager.id,
        host: manager.network.tailscaleName,
        hub,
        userId: access.userId,
      },
      access.request
    );
    const checks = await (dependencies.install ?? installManagerAgent)(
      workspace,
      { node: manager.id, enrollment },
      run
    );
    if (checks.some((check) => check.status === 'fail')) return checks;
    const evidence = await waitForSample(
      hub,
      manager.id,
      access.request,
      dependencies.sampleDeadlineMs ?? 90_000
    );
    return [...checks, ...evidence.checks];
  } catch (error) {
    return unavailable(errorCode(error));
  }
}

async function enrollWorker(
  node: FleetNode,
  definition: FleetDefinition,
  context: MonitoringDependencies & { revision: string; run: Runner }
): Promise<Check[]> {
  const { revision, run } = context;
  if (roleOf(definition, node.id) !== 'worker')
    return unavailable('BESZEL_NOT_ENROLLED');
  const hub = hubUrl(definition);
  if (!(await hubReachable(hub, run)))
    return unavailable('BESZEL_HUB_UNREACHABLE');
  const tailnet = await discoverTailnet(run);
  const target = tailnet.computers.find((peer) => peer.id === node.tailscaleId);
  if (!target) return unavailable('BESZEL_NODE_TAILNET_REQUIRED');
  const access = await (context.access ?? hubAccess)(hub);
  const enrollment = await enrollBeszel(
    { node: node.id, host: target.dns, hub, userId: access.userId },
    access.request
  );
  const checks = await installRemoteAgent(node, revision, enrollment, run);
  if (checks.some((check) => check.status === 'fail')) return checks;
  const evidence = await waitForSample(
    hub,
    node.id,
    access.request,
    context.sampleDeadlineMs ?? 90_000
  );
  return [...checks, ...evidence.checks];
}

const PASSTHROUGH = [
  'BESZEL_ACCOUNT_REQUIRED',
  'BESZEL_ACCOUNT_INVALID',
  'BESZEL_AUTH_REQUIRED',
  'BESZEL_API_UNAVAILABLE',
];
function errorCode(error: unknown): string {
  return error instanceof Error && PASSTHROUGH.includes(error.message)
    ? error.message
    : 'BESZEL_ENROLLMENT_INCOMPLETE';
}

async function hubReachable(hub: string, run: Runner): Promise<boolean> {
  const probe = await run(
    [
      'curl',
      '-fsS',
      '--max-time',
      '10',
      '-o',
      '/dev/null',
      `${hub}/api/health`,
    ],
    { timeoutMs: 15_000 }
  );
  return probe.ok;
}

const remedies = (): Record<string, string> => ({
  BESZEL_ACCOUNT_REQUIRED: `The hub rejected the fleet login ${fleetIdentity()}. A new hub on the manager creates it on first start from BESZEL_FLEET_AUTH; an older hub needs it once, by its superuser, as a verified users record with that Vault password. Never paste the password on a command line.`,
  BESZEL_HUB_UNREACHABLE:
    'The hub runs on the manager; keep it awake and Docker Desktop running, then rerun fleet-sync from the manager so it converges the hub first.',
  BESZEL_NODE_TAILNET_REQUIRED:
    'The worker is not visible on the tailnet. Sign it in to Tailscale and record its tailscaleId in the local roster, then rerun fleet-sync.',
  BESZEL_NOT_ENROLLED:
    'Only workers declared in fleet.json run the agent over SSH; fleet-sync installs the manager’s own agent locally after its hub.',
});
function unavailable(code: string): Check[] {
  return [
    {
      id: 'beszel:enrollment',
      status: 'fail',
      summary: code,
      remedy: {
        action:
          remedies()[code] ??
          "Verify the manager's private hub is running and the manager has BESZEL_FLEET_AUTH through existing Vault authorization. The normal hub account must access these systems. Inspect duplicate registration/host conflicts before retry; no token or raw response is printed.",
      },
    },
  ];
}

async function waitForSample(
  hub: string,
  node: string,
  request: Parameters<typeof verifyBeszel>[2],
  deadlineMs: number
) {
  const deadline = Date.now() + deadlineMs;
  let evidence = await verifyBeszel(hub, node, request);
  while (
    Date.now() < deadline &&
    evidence.checks.some((check) => check.summary === 'BESZEL_METRICS_STALE')
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    evidence = await verifyBeszel(hub, node, request);
  }
  return evidence;
}
