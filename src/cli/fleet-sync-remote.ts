import { createHash } from 'node:crypto';
import { IDES } from '../ide';
import { enabled, workerChecks } from '../ide/orchestrate';
import { idesOf } from '../ide/definition';
import { pairIfRequested, rememberEnvironment } from '../t3/pairing';
import { managerT3 } from '../t3/peer-link';
import { authorizePrivilege } from './fleet-sync-privilege';
import { authorizeVault } from './fleet-sync-vault';
import { managerFailure } from '../manager-failure';
import { managerText, stdoutColor } from './fleet-sync-output';
import { syncProgress, type SyncProgress } from './fleet-sync-progress';
import { saveReport } from './fleet-sync-report';
import { synchronizeMonitoring } from './fleet-sync-monitoring';
import { convergeManager } from './fleet-sync-manager';
import { FleetUsageError } from '../errors';
import { selectNodes } from '../config';
import { loadRoster } from './roster';
import { enrolledRoster } from '../definition';
import { readParked, readWorkerStates } from '../state/workers';
import { withoutParked } from '../worker-parking';
import { reconcileRecords } from './fleet-sync-records';
import type { FleetDefinition } from '../definition';
import { fleet as definition } from '../fleet-config';
import { synchronizeManager } from '../manager-sync';
import { inspectBootstrap } from '../manager-sync';
import {
  prepareBootstrap,
  bootstrapRemote,
  readsTailnetKey,
} from '../remote-bootstrap';
import { secret } from '../fleet-config';
import { fleetTailnetControl, type TailnetControl } from '../tailnet-control';
import { discoverTailnet, type TailnetComputer } from '../tailscale';
import { deployWorker } from './fleet-sync-worker';
import { packagePlaybook } from '../platform/ansible';
import { machineRoot } from './fleet-sync';
import {
  blocking,
  type Check,
  type FleetNode,
  type NodeReport,
  type Runner,
} from '../types';
import { diagnostic } from '../diagnostics';
import type { DeployNode, ManagerReport } from '../manager-sync';
import type { FleetSyncOptions } from './fleet-sync';
import type { Settings } from './settings';
import type { CommandOutcome } from './contracts';

/** `settle` runs once the fleet's result is known and before it is reported:
 * it records the result and returns the check that says so.
 */
export async function selected(
  options: FleetSyncOptions,
  settings: Settings,
  run: Runner,
  settle?: (report: ManagerReport) => Promise<Check>
): Promise<CommandOutcome> {
  if (!options.revision)
    throw new FleetUsageError('An approved source revision is required.');
  const canonical = definition;
  // Workers whose record disappeared are retired first (planned in a
  // preview), so they are no longer in the roster.
  const records = await reconcileRecords(canonical, settings.config, run, {
    apply: Boolean(options.apply),
  });
  let roster;
  try {
    const declared = new Set(canonical.workers.map((worker) => worker.id));
    const loaded = await loadRoster(settings.config);
    roster = enrolledRoster(canonical, {
      ...loaded,
      nodes: loaded.nodes.filter(
        (node) =>
          declared.has(node.id) ||
          readWorkerStates().workers[node.id]?.origin !== 'records'
      ),
    });
  } catch {
    return enrollmentRequired(canonical, options.revision);
  }
  // A parked worker is not contacted and never the canary.
  const active = withoutParked(
    scopeDefinition(canonical, options.node),
    selectNodes(roster, options.node ?? []),
    readParked(),
    new Date()
  );
  const { nodes, definition: scoped } = active;
  const notes = [...records, ...active.checks];
  const ui = interfaceOptions(options);
  const planFingerprint = createHash('sha256')
    .update(
      JSON.stringify({ revision: options.revision, definition: scoped, nodes })
    )
    .digest('hex');
  if (
    options.expectedPlanFingerprint &&
    options.expectedPlanFingerprint !== planFingerprint
  )
    return failed(
      managerFailure(
        scoped,
        options.revision,
        'FLEET_PLAN_STALE',
        'Manager connection bindings or target policy changed after approval. Inspect a fresh plan and approve it; no source preparation or node mutation occurred.'
      )
    );
  const prepared = options.apply
    ? await prepareBootstrap(machineRoot(), options.revision, run, {
        definition: canonical,
        checkout: settings.workspace,
      })
    : null;
  const payload =
    prepared && options.restartBusy
      ? { ...prepared, restartBusy: true }
      : prepared;
  const started = Date.now();
  const report = await synchronizeManager(
    {
      definition: scoped,
      nodes,
      revision: options.revision,
      apply: Boolean(options.apply),
      ...canary(canonical, options),
      ...serial(options),
      progress: (node, phase) => ui.progress.step(node, phase),
      finished: (node) => ui.progress.finished(node),
      manager: () =>
        convergeManager(
          canonical,
          {
            revision: options.revision!,
            apply: Boolean(options.apply),
            workspace: settings.workspace,
          },
          run
        ),
    },
    run,
    deployWithMonitoring(payload, canonical, run, {
      ...ui,
      workspace: settings.workspace,
      roster: settings.config,
      ...rebootOptions(options),
    })
  ).finally(() => ui.progress.stop());
  if (options.enrollment) reportEnrollment(report, options.enrollment);
  report.checks.push(...notes);
  if (settle) report.checks.push(await settle(report));
  return outcome(report, planFingerprint, started);
}

/** Maintenance reboots go one worker at a time, and a worker that does not
 * come back ready stops the others.
 */
function serial(options: FleetSyncOptions): { serial?: true } {
  return options.maintenanceReboot ? { serial: true } : {};
}

function rebootOptions(options: FleetSyncOptions): {
  readyBefore: string[];
  maintenanceReboot?: true;
  force?: true;
} {
  return {
    readyBefore: options.readyBefore ?? [],
    ...(options.maintenanceReboot ? { maintenanceReboot: true } : {}),
    ...(options.force ? { force: true } : {}),
  };
}

/** The workers this run enrolled, and why another was not: the checks land
 * on the worker they are about.
 */
export function reportEnrollment(
  report: ManagerReport,
  enrollment: NonNullable<FleetSyncOptions['enrollment']>
): void {
  report.enrolled = enrollment.enrolled;
  for (const { node, check } of enrollment.checks) {
    const entry = report.nodes.find((candidate) => candidate.node === node);
    if (!entry) continue;
    entry.checks.unshift(check);
    entry.diagnostics = entry.checks.map((each) => diagnostic(node, each));
    if (blocking(check)) report.ok = false;
  }
}

/** A revision new to the fleet is proven on one worker before the rest: the
 * one `--canary` or fleet.json names, else the first declared worker, and
 * the next reachable one when that cannot be reached. Repeating a revision
 * that already converged everywhere needs no canary, so every worker
 * converges at once.
 */
function canary(
  canonical: FleetDefinition,
  options: FleetSyncOptions
): { canary?: string } {
  if (
    options.canary &&
    !canonical.workers.some((worker) => worker.id === options.canary)
  )
    throw new FleetUsageError(
      '--canary names a worker fleet.json does not declare.'
    );
  const preferred =
    options.canary ?? canonical.canary ?? canonical.workers[0]?.id;
  return preferred && !options.rolledOut ? { canary: preferred } : {};
}

/** Saves the full JSON report, then renders the short human summary. */
async function outcome(
  report: Awaited<ReturnType<typeof synchronizeManager>>,
  planFingerprint: string,
  started: number
): Promise<CommandOutcome> {
  const data = { ...report, planFingerprint };
  const reportPath = await saveReport(machineRoot(), data);
  return {
    exitCode: report.ok ? 0 : 1,
    data,
    text: managerText(report, {
      color: stdoutColor(),
      durationMs: Date.now() - started,
      ...(reportPath ? { reportPath } : {}),
    }),
  };
}

function enrollmentRequired(
  canonical: FleetDefinition,
  revision: string
): CommandOutcome {
  const report = managerFailure(
    canonical,
    revision,
    'FLEET_MANAGER_ENROLLMENT_REQUIRED',
    'Create or migrate private manager connection overrides for the canonical fleet. Resolve conflicting IDs/SSH aliases; discovery cannot authorize membership.'
  );
  return failed(report);
}

function failed(report: ReturnType<typeof managerFailure>): CommandOutcome {
  return {
    exitCode: 1,
    data: report,
    text: managerText(report, { color: stdoutColor() }),
  };
}

function deployWithMonitoring(
  payload: Awaited<ReturnType<typeof prepareBootstrap>>,
  canonical: FleetDefinition,
  run: Runner,
  ui: {
    progress: SyncProgress;
    interactiveAuthorization: boolean;
    /** The manager's checkout, and the roster an identity is recorded in. */
    workspace: string;
    roster: string;
    passwordLogin: boolean;
    readyBefore: string[];
    maintenanceReboot?: boolean;
    force?: boolean;
  }
): DeployNode {
  // Asked once per run, and only when a worker needs them.
  let control: Promise<TailnetControl | null> | undefined;
  let computers: Promise<TailnetComputer[]> | undefined;
  const converge = convergeWorker(payload, canonical, run, ui);
  return async (node, revision) => {
    if (!payload || payload.revision !== revision)
      return {
        node: node.id,
        checks: [
          {
            id: 'source:bootstrap',
            status: 'fail' as const,
            summary: 'FLEET_APPROVED_BOOTSTRAP_UNAVAILABLE',
            remedy: {
              action:
                'Install Git on the manager and verify the approved source contains the tracked remote bootstrap and matches this package’s canonical fleet definition. Use the matching package release after a membership change. No manager credentials are forwarded.',
            },
          },
        ],
      };
    return deployWorker(node, revision, {
      definition: canonical,
      playbook: packagePlaybook(run),
      converge,
      control: () =>
        (control ??= fleetTailnetControl(canonical.tailnet, secret)),
      computers: () =>
        (computers ??= discoverTailnet(run).then((found) => found.computers)),
      readyBefore: ui.readyBefore,
      ...(ui.maintenanceReboot ? { maintenanceReboot: true } : {}),
      ...(ui.force ? { force: true } : {}),
      acceptsTailnetKey: readsTailnetKey(payload.script),
    });
  };
}

/** One converge of a worker: privilege, Vault, the bootstrap, then what is
 * verified from the manager and the worker's monitoring.
 */
function convergeWorker(
  payload: Awaited<ReturnType<typeof prepareBootstrap>>,
  canonical: FleetDefinition,
  run: Runner,
  ui: {
    progress: SyncProgress;
    interactiveAuthorization: boolean;
    workspace: string;
    roster: string;
    passwordLogin: boolean;
  }
) {
  return async (
    node: FleetNode,
    revision: string,
    tailnetKey?: string
  ): Promise<NodeReport> => {
    // Password prompts need a quiet terminal: no spinner while authorizing.
    if (ui.interactiveAuthorization) {
      ui.progress.stop();
      const checks = await authorizePrivilege(
        node,
        payload!.authorizeSudo,
        run
      );
      if (checks.length) return { node: node.id, checks };
    }
    const vault = {
      interactive: ui.interactiveAuthorization,
      passwordLogin: ui.passwordLogin,
    };
    if (ui.interactiveAuthorization) ui.progress.stop();
    const before = await authorizeVault(node, vault, run);
    ui.progress.step(node.id, 'Converging (remote lock, install, verify)');
    const result = await bootstrapRemote(node, payload!, run, {
      progress: (line) => ui.progress.step(node.id, line),
      ...(tailnetKey ? { tailnetKey } : {}),
    });
    // A fresh node gets vault from the bootstrap; log it in now. Its provider
    // checks in this run predate the login, so the next sync verifies them.
    result.checks.push(
      ...(before.length ? before : await authorizeVault(node, vault, run))
    );
    // Workers are Linux by definition.
    ui.progress.step(node.id, 'Verifying SSH, OS and T3');
    result.checks.push(...(await inspectBootstrap(node, run)));
    result.checks.push(
      ...(await workerChecks(enabled(idesOf(canonical), IDES), node, {
        run,
        workspace: ui.workspace,
        earlier: result.checks,
        remember: async (id, identity) => {
          await rememberEnvironment(ui.roster, id, identity);
        },
        pair: (target) =>
          pairIfRequested(target, {
            roster: ui.roster,
            run,
            manager: managerT3(run),
          }),
      }))
    );
    if (
      result.checks.some(
        (check) => check.id === 'configuration:apply' && check.status === 'pass'
      )
    ) {
      result.checks = result.checks.filter(
        (check) => check.id !== 'beszel:freshness'
      );
      ui.progress.step(node.id, 'Enrolling monitoring');
      result.checks.push(
        ...(await synchronizeMonitoring(node, canonical, revision, run))
      );
    }
    return result;
  };
}

function scopeDefinition(canonical: FleetDefinition, ids?: string[]) {
  return ids?.length
    ? {
        ...canonical,
        workers: canonical.workers.filter((node) => ids.includes(node.id)),
      }
    : canonical;
}
function interfaceOptions(options: FleetSyncOptions) {
  return {
    progress: syncProgress(!options.json),
    passwordLogin: Boolean(options.vaultPasswordLogin),
    interactiveAuthorization: Boolean(
      options.interactiveAuthorization &&
      !options.json &&
      !options.nonInteractive
    ),
  };
}
