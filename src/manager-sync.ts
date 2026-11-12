import { diagnostic, type Diagnostic } from './diagnostics';
import {
  blocking,
  type Check,
  type FleetNode,
  type NodeReport,
  type Runner,
} from './types';
import {
  discoverTailnet,
  keyExpiryCheck,
  type TailnetComputer,
} from './tailscale';
import { matchComputers } from './tailnet-matching';
import { sshArgs, sshFailure } from './ssh';
import type { FleetDefinition, MachineDefinition } from './definition';
import { publicHubUrl } from './monitoring/beszel';
import {
  evaluateEnvironment,
  evaluateMachineClass,
  evaluatePlatform,
  evaluateSize,
  PLATFORM_PROBE,
} from './machine/platform';

export interface ManagerNode extends NodeReport {
  /** The singleton manager converges locally; workers over SSH. */
  role?: 'manager' | 'worker';
  reachability: 'online' | 'offline' | 'missing' | 'conflict' | 'unknown';
  desiredRevision: string | null;
  appliedRevision: string | null;
  durationMs: number;
  diagnostics?: Diagnostic[];
}
export interface ManagerReport {
  version: 3;
  command: 'fleet-sync';
  execution: 'manager-push';
  ok: boolean;
  applied: boolean;
  desiredRevision: string | null;
  /** The worker that proved a revision new to the fleet first, when one did. */
  canary?: string;
  checks: Check[];
  nodes: ManagerNode[];
  candidates: number;
  dashboardUrl: string | null;
}
export type DeployNode = (
  node: FleetNode,
  revision: string
) => Promise<NodeReport>;

/** Minimal read-only POSIX inspection requires no workspace, Node, Bun or Git. */
export async function inspectBootstrap(
  node: FleetNode,
  run: Runner
): Promise<Check[]> {
  const result = await run([...sshArgs(node), PLATFORM_PROBE], {
    timeoutMs: 20_000,
  });
  if (!result.ok) return [sshFailure(result)];
  const baseline = evaluatePlatform(result.stdout);
  const environment = evaluateEnvironment(result.stdout);
  const machine = evaluateMachineClass(result.stdout);
  const size = evaluateSize(result.stdout);
  return [
    {
      id: 'ssh:fresh-session',
      status: 'pass',
      summary:
        'Fresh host-key-verified SSH session succeeded without remote developer prerequisites.',
    },
    {
      id: baseline.id,
      status: baseline.supported ? 'pass' : 'fail',
      summary: baseline.summary,
      remedy: {
        action:
          'Review the release/architecture migration in source. No operating-system upgrade or downgrade is performed.',
      },
    },
    {
      id: environment.id,
      status: environment.supported ? 'pass' : 'fail',
      summary: environment.summary,
      remedy: {
        action:
          'Run the worker on a physical or virtual machine of its own; docs/support-matrix.md lists what is supported.',
      },
    },
    { id: machine.id, status: 'pass', summary: machine.summary },
    ...(size
      ? [
          {
            id: size.id,
            status: size.supported ? ('pass' as const) : ('fail' as const),
            summary: size.summary,
            ...(size.supported
              ? {}
              : {
                  remedy: {
                    action:
                      'Resize the machine to at least the minimum worker size docs/worker-contract.md states, then run fleet-sync. Nothing was installed.',
                  },
                }),
          },
        ]
      : []),
  ];
}

/** One invocation, one immutable revision. Serial application bounds pressure and
 * lets a failed declared canary stop promotion; diagnostics still cover all nodes.
 */
export async function synchronizeManager(
  input: {
    definition: FleetDefinition;
    nodes: FleetNode[];
    revision: string;
    apply: boolean;
    canary?: string;
    progress?: (node: string, phase: string) => void;
    /** Called once per node as soon as its result is final. */
    finished?: (node: ManagerNode) => void;
    /** Converges the manager locally; omitted in tests. */
    manager?: () => Promise<ManagerNode>;
  },
  run: Runner,
  deploy: DeployNode
): Promise<ManagerReport> {
  const tailnet = await discoverTailnet(run);
  const matches = await matchComputers(input.nodes, tailnet.computers, run);
  const report: ManagerReport = {
    version: 3,
    command: 'fleet-sync',
    execution: 'manager-push',
    ok: false,
    applied: false,
    desiredRevision: input.revision,
    checks: [
      ...tailnet.checks,
      ...(tailnet.computers.some((peer) => peer.self)
        ? [keyExpiryCheck(tailnet.computers.find((peer) => peer.self))]
        : []),
    ],
    // Printed for people: the stable public name, never a tailnet address.
    dashboardUrl: publicHubUrl(),
    nodes: [],
    candidates: tailnet.computers.filter(
      (peer) => !peer.self && !matches.get(peer.id)?.length
    ).length,
  };
  const managerRun = input.manager ? convergeManagerNode(input) : null;
  // The manager finishes first: updating it may restart the proxy every
  // worker is then verified against.
  if (managerRun) await managerRun;
  const workers = await Promise.all(
    input.definition.workers.map((machine) => {
      input.progress?.(
        machine.id,
        'Inspecting enrolled identity and fresh SSH access'
      );
      return inspectManagerNode(
        machine,
        {
          nodes: input.nodes,
          revision: input.revision,
          computers: tailnet.computers,
          matches,
        },
        run
      );
    })
  );
  report.nodes.push(...workers);
  if (input.apply) await applyNodes(report, input, deploy);
  else workers.forEach((node) => input.finished?.(node));
  if (managerRun) report.nodes.unshift(await managerRun);
  report.ok = ready(report);
  for (const node of report.nodes)
    node.diagnostics = node.checks.map((check) => diagnostic(node.node, check));
  return report;
}
async function convergeManagerNode(input: {
  definition: FleetDefinition;
  progress?: (node: string, phase: string) => void;
  finished?: (node: ManagerNode) => void;
  manager?: () => Promise<ManagerNode>;
}): Promise<ManagerNode> {
  input.progress?.(
    input.definition.manager.id,
    'Converging the manager and its singleton services locally'
  );
  const manager = await input.manager!();
  input.finished?.(manager);
  return manager;
}

/** Ready when nothing required failed; warnings and skips do not count. */
function ready(report: ManagerReport): boolean {
  return (
    !report.checks.some(blocking) &&
    report.nodes.length > 0 &&
    report.nodes.every(
      (node) => node.checks.length > 0 && !node.checks.some(blocking)
    )
  );
}

async function applyNodes(
  report: ManagerReport,
  input: {
    nodes: FleetNode[];
    revision: string;
    canary?: string;
    progress?: (node: string, phase: string) => void;
    finished?: (node: ManagerNode) => void;
  },
  deploy: DeployNode
): Promise<void> {
  const workers = report.nodes.filter((node) => node.role !== 'manager');
  const canary = input.canary
    ? chooseCanary(workers, input.canary, input.nodes)
    : undefined;
  if (canary) report.canary = canary.node;
  let blocked = report.checks.some(blocking);
  const step = async (result: ManagerNode) => {
    const deployable = mayDeploy(result, input.nodes);
    if (await rollOut(result, { deployable, blocked }, input, deploy))
      report.applied = true;
    input.finished?.(result);
    return deployable;
  };
  // The canary goes first; a failed canary stops promotion. The remaining
  // workers are independent, so they converge concurrently.
  if (canary) {
    const deployable = await step(canary);
    if (!deployable || canary.checks.some(blocksPromotion)) blocked = true;
  }
  await Promise.all(workers.filter((node) => node !== canary).map(step));
}

/** A revision new to the fleet is proven on one worker first: the preferred
 * one, or when it cannot be reached (powered off, being rebuilt, offline)
 * the next worker in declared order that can. An unreachable worker is
 * reported as such and never blocks the others; only a canary that was
 * deployed and failed stops promotion. When the run selects only later
 * workers, the first selected one proves it instead: narrowing a run never
 * skips the canary.
 */
function chooseCanary(
  workers: ManagerNode[],
  preferred: string,
  nodes: FleetNode[]
): ManagerNode | undefined {
  const first = workers.find((node) => node.node === preferred);
  const order = first
    ? [first, ...workers.filter((node) => node !== first)]
    : workers;
  return order.find((node) => mayDeploy(node, nodes));
}

/** One node's rollout step; true when its remote operation ran. */
async function rollOut(
  result: ManagerNode,
  { deployable, blocked }: { deployable: boolean; blocked: boolean },
  input: {
    nodes: FleetNode[];
    revision: string;
    progress?: (node: string, phase: string) => void;
  },
  deploy: DeployNode
): Promise<boolean> {
  if (!deployable) return false;
  if (blocked) {
    result.checks.push({
      id: 'rollout:promotion',
      status: 'fail',
      summary: 'FLEET_PROMOTION_BLOCKED',
      remedy: {
        action:
          'Resolve the discovery or canary failure above, then rerun the same approved revision.',
      },
    });
    return false;
  }
  input.progress?.(
    result.node,
    'Applying the approved revision and verifying postconditions'
  );
  return deployNode(result, input, deploy);
}

/** Deploys one node and records its evidence; true when the remote ran. */
async function deployNode(
  result: ManagerNode,
  input: { nodes: FleetNode[]; revision: string },
  deploy: DeployNode
): Promise<boolean> {
  const started = Date.now();
  let ran = false;
  try {
    const outcome = await deploy(
      input.nodes.find((node) => node.id === result.node)!,
      input.revision
    );
    ran = true;
    result.checks.push(...outcome.checks);
    if (!outcome.checks.length)
      result.checks.push({
        id: 'rollout:evidence',
        status: 'fail',
        summary: 'FLEET_VERIFICATION_MISSING',
      });
  } catch {
    result.checks.push({
      id: 'rollout:operation',
      status: 'fail',
      summary: 'FLEET_REMOTE_OPERATION_FAILED',
      remedy: {
        action:
          'Inspect the remote operation lock before retrying. A disconnected manager does not establish that installation stopped.',
      },
    });
  }
  result.durationMs += Date.now() - started;
  if (!result.checks.some(blocking)) result.appliedRevision = input.revision;
  return ran;
}

function connectionState(
  conflict: boolean,
  peer: TailnetComputer | undefined
): ManagerNode['reachability'] {
  if (conflict) return 'conflict';
  if (!peer) return 'missing';
  return peer.online ? 'online' : 'offline';
}
async function inspectManagerNode(
  machine: MachineDefinition,
  context: {
    nodes: FleetNode[];
    revision: string;
    computers: TailnetComputer[];
    matches: Map<string, FleetNode[]>;
  },
  run: Runner
): Promise<ManagerNode> {
  const { nodes, revision, computers, matches } = context;
  const id = machine.id;
  const started = Date.now();
  const node = nodes.find((entry) => entry.id === id);
  const peers = computers.filter((peer) =>
    matches.get(peer.id)?.some((entry) => entry.id === id)
  );
  const peer = peers[0];
  const conflict =
    peers.length > 1 || (peer && matches.get(peer.id)!.length > 1);
  const checks: Check[] = [];
  if (!node)
    checks.push({
      id: 'enrollment:connection',
      status: 'fail',
      summary: 'FLEET_CONNECTION_REQUIRED',
      remedy: {
        action:
          'Add this canonical node’s reviewed SSH alias and managed workspace path to the private manager overrides. Do not substitute a discovered peer.',
      },
    });
  else if (conflict)
    checks.push({
      id: 'tailscale:identity',
      status: 'fail',
      summary: 'TAILSCALE_IDENTITY_CONFLICT',
      remedy: {
        action:
          'Resolve duplicate alias/device mappings before enrollment or apply.',
      },
    });
  else {
    checks.push(...(await inspectBootstrap(node, run)));
    checks.push(...identityChecks(node, peer));
    if (peer) checks.push(keyExpiryCheck(peer));
  }
  if (!peer || !peer.online)
    checks.push({
      id: 'tailscale:reachability',
      status: 'fail',
      summary: peer ? 'TAILSCALE_NODE_OFFLINE' : 'TAILSCALE_NODE_MISSING',
      remedy: {
        action:
          'Restore the intended node’s private connection. A trusted LAN SSH route can be inspected, but discovery never enrolls a replacement.',
      },
    });
  return {
    node: id,
    role: 'worker',
    checks,
    desiredRevision: revision,
    appliedRevision: null,
    durationMs: Date.now() - started,
    reachability: connectionState(Boolean(conflict), peer),
  };
}

function identityChecks(
  node: FleetNode,
  peer: TailnetComputer | undefined
): Check[] {
  const checks: Check[] = [];
  if (!node.tailscaleId || (peer && peer.id !== node.tailscaleId))
    checks.push({
      id: 'tailscale:enrolled-identity',
      status: 'fail',
      summary: node.tailscaleId
        ? 'TAILSCALE_DEVICE_REPLACED'
        : 'TAILSCALE_ENROLLMENT_REQUIRED',
      remedy: {
        action:
          'Verify the device identity and SSH host key, then record its stable tailscaleId in the reviewed private connection override. Names alone cannot authorize replacement.',
      },
    });
  return checks;
}

function mayDeploy(result: ManagerNode, nodes: FleetNode[]): boolean {
  const allowBootstrap =
    nodes.find((node) => node.id === result.node)?.bootstrapViaSsh === true;
  return result.checks.every(
    (check) =>
      !blocking(check) ||
      (allowBootstrap &&
        [
          'TAILSCALE_NODE_OFFLINE',
          'TAILSCALE_NODE_MISSING',
          'TAILSCALE_ENROLLMENT_REQUIRED',
        ].includes(check.summary))
  );
}

/** Service/account acceptance remains required for readiness, but a missing
 * external account, dashboard or client pairing must not stop independent OS
 * configuration on other nodes. Actual deployment failures stop promotion.
 */
export function blocksPromotion(check: Check): boolean {
  if (!blocking(check)) return false;
  return !/^(worker:|beszel:|provider:|agent:|proxy:|t3:end-to-end$|t3:paired-access$|t3:policy-loaded$|t3:running-version$|ubuntu:boot-policy$)/.test(
    check.id
  );
}
