import type { ManagerReport } from '../manager-sync';
import { localCheckoutRevision } from '../machine/local-source';
import {
  definitionSource,
  fleet as canonicalDefinition,
  reloadFleet,
} from '../fleet-config';
import { managerFailure } from '../manager-failure';
import { managerText, stdoutColor } from './fleet-sync-output';
import { managerSchedule, type ScheduleAction } from './fleet-sync-schedule';
import { enrollManager } from './fleet-sync-enrollment';
import { authorizeManager } from './fleet-sync-vault';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import {
  isRevision,
  withMachineLock,
  ensurePrivateRoot,
  type Enrollment,
} from '../machine/state';
import { loadEnrollment } from '../state/enrollment';
import { legacyHome } from '../state/paths';
import {
  appendRun,
  summarizeRun,
  type SyncRun,
  type Trigger,
} from '../state/history';
import {
  DIVERGED_REMEDY,
  mutateState,
  refresh,
  leaseConflict,
  leaseHeldMessage,
  stateContext,
  type Standing,
} from '../state/sync';
import { runRecord } from './fleet-sync-state';
import { planSources, planText, syncPlan } from './fleet-sync-plan';
import { runCommand } from '../runner';
import type { Runner } from '../types';
import type { Settings } from './settings';
import type { CommandOutcome } from './contracts';
import { FleetUsageError } from '../errors';
import { FleetLockError } from '../machine/lock-error';
import { selected } from './fleet-sync-remote';
import { managerIdentity } from './fleet-sync-manager';
import { managerRunScript, rehome } from './fleet-sync-checkout';
import { syncAccounts } from './fleet-sync-accounts';
import { packageInfo } from '../package-info';
import {
  forwardingDisabled,
  forwardToManager,
  type ForwardSpawn,
} from './fleet-sync-forward';

export interface FleetSyncOptions {
  revision?: string;
  /** Converge to the revision applied before the current one. */
  rollback?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  node?: string[];
  /** The worker to prove a revision new to the fleet on first, when it is
   * reachable; overrides `canary` in fleet.json.
   */
  canary?: string;
  /** Opt-in: a worker without a token of its own may be logged in with the
   * fleet's shared Vault user, typed on its own terminal.
   */
  vaultPasswordLogin?: boolean;
  all?: boolean;
  schedule?: ScheduleAction;
  /** `accounts`: only the account-derived configuration, on every node. */
  only?: string;
  /** Internal: this revision already converged the whole fleet, so no canary
   * has to prove it first and every worker converges at once.
   */
  rolledOut?: boolean;
  /** Internal: set for interactive terminal runs (sudo enrollment prompts). */
  interactiveAuthorization?: boolean;
  expectedPlanFingerprint?: string;
  /** Take the manager lease from another manager before it expired. */
  takeOver?: boolean;
  /** Restart a worker's T3 for a new release or policy even while agent
   * turns run, which ends them; by default the restart waits for idle.
   */
  restartBusy?: boolean;
}
export function machineRoot(): string {
  const root = join(homedir(), '.local/share/personal/fleet/manager');
  // One-time move from the pre-topology name; keeps the approved revision.
  const legacy = join(homedir(), '.local/share/personal/fleet/controller');
  if (!existsSync(root) && existsSync(legacy)) renameSync(legacy, root);
  return root;
}

/** Public contract v3: the manager converges itself, then every enrolled worker. */
export async function fleetSync(
  options: FleetSyncOptions,
  settings: Settings,
  run: Runner = runCommand,
  forward?: ForwardSpawn
): Promise<CommandOutcome> {
  validate(options);
  if (!(await onManager(run)))
    return offManager(options, settings, run, forward);
  if (options.schedule === 'status') return scheduleStatus(settings, run);
  if (options.only === 'accounts') return onlyAccounts(options, settings, run);
  const sync = () =>
    managerSync(options, settings, {
      run,
      root: machineRoot(),
      restart: sync,
    });
  if (options.dryRun || options.schedule) return sync();
  const trigger = runTrigger();
  const startedAt = new Date();
  const outcome = await sync();
  await recordRun(
    summarizeRun(
      outcome.data,
      { startedAt, finishedAt: new Date() },
      trigger,
      outcome.exitCode
    ),
    run
  );
  return outcome;
}

/** Runs the manager's schedule starts say so in their environment. */
function runTrigger(env = process.env): Trigger {
  return env['DEVFLEET_TRIGGER'] === 'schedule' ? 'schedule' : 'operator';
}

/** Appends the run to the history in the fleet state and uploads it. A
 * history that cannot be written never changes the run's result.
 */
async function recordRun(entry: SyncRun, run: Runner): Promise<void> {
  try {
    await mutateState(stateContext(run), () => appendRun(entry));
  } catch {
    // Reported by the next fleet-state or fleet-sync run.
  }
}

export interface ManagerSync {
  run: Runner;
  /** This machine's run lock and caches. */
  root: string;
  /** Starts the request over once the fleet state has been replaced. */
  restart: () => Promise<CommandOutcome>;
}

/** Why the fleet state stops this run before any machine or the state is
 * changed, if it does.
 */
function stateRefusal(
  standing: Standing,
  options: FleetSyncOptions,
  run: Runner,
  revision: string
): CommandOutcome | null {
  if (standing === 'diverged')
    return actionRequired('FLEET_STATE_DIVERGED', DIVERGED_REMEDY, revision);
  // One manager at a time: another one's lease stops this run.
  const held = leaseConflict({
    ...stateContext(run),
    takeOver: options.takeOver === true,
  });
  return held
    ? actionRequired(
        'FLEET_MANAGER_LEASE_HELD',
        leaseHeldMessage(held),
        revision
      )
    : null;
}

/** fleet-sync on the machine already known to be the manager. */
export async function managerSync(
  options: FleetSyncOptions,
  settings: Settings,
  { run, root, restart }: ManagerSync
): Promise<CommandOutcome> {
  await ensurePrivateRoot(root);
  const state = await loadEnrollment(legacyHome() ? root : null);
  const revision = await managerRevision(options, state, settings, run);
  if (typeof revision !== 'string') return revision;
  if (options.schedule)
    return scheduleRequest(options, revision, settings, run);
  const rehomed = await rehome(
    options,
    { revision, workspace: settings.workspace, root },
    run
  );
  if (rehomed === 'unavailable')
    return actionRequired(
      'FLEET_SOURCE_UNAVAILABLE',
      `Revision ${revision} could not be taken from ${canonicalDefinition.source.repository}, so nothing was changed. Check the network and Git access to it, and that the revision is pushed there; fleet-sync never converges from the package or working tree it was started in.`,
      revision
    );
  if (rehomed !== 'here') return rehomed;
  // The bucket is the source of truth: a run, and a preview, starts from its
  // version of the configuration, the roster and the approval, not from a
  // stale local copy. Refreshing never uploads.
  const fresh = await refresh(stateContext(run));
  const refused = stateRefusal(fresh.standing, options, run, revision);
  if (refused) return refused;
  if (fresh.replaced) {
    // Everything read so far came from the stale copy, the manager's own
    // identity included.
    reloadFleet();
    return restart();
  }
  if (options.dryRun)
    return preview({ ...options, revision }, settings, {
      run,
      root,
      applied: state?.appliedRevision ?? null,
      standing: fresh.standing,
    });
  return authorizeAndApply(root, state, options, {
    settings,
    run,
    revision,
    standing: fresh.standing,
  });
}

/** The revision the manager converges to, or why there is none. */
async function managerRevision(
  options: FleetSyncOptions,
  state: { approvedRevision?: string; previousRevision?: string } | null,
  settings: Settings,
  run: Runner
): Promise<string | CommandOutcome> {
  const explicit = requestedRevision(options, state);
  if (explicit === null)
    return actionRequired(
      'FLEET_ROLLBACK_UNAVAILABLE',
      'Nothing was changed: the fleet state records no revision applied before the current one. Install the dev-fleet version to go back to and run fleet-sync.'
    );
  const revision = await selectedRevision(
    explicit,
    state?.approvedRevision,
    settings,
    run
  );
  if (!isRevision(revision))
    return actionRequired(
      'FLEET_REVISION_REQUIRED',
      'No revision to converge to. Run the published dev-fleet package (it names the commit it was built from), or select a full commit SHA with --revision.'
    );
  return revision;
}

/** The preview: the read-only report of every machine, and the plan of what
 * a sync would change on them.
 */
async function preview(
  options: FleetSyncOptions & { revision: string },
  settings: Settings,
  context: {
    run: Runner;
    root: string;
    applied: string | null;
    standing: Standing;
  }
): Promise<CommandOutcome> {
  const outcome = await selected(options, settings, context.run);
  const report = outcome.data as { nodes?: { node?: unknown }[] };
  const plan = await syncPlan(
    {
      from: context.applied,
      to: options.revision,
      state: context.standing,
      nodes: (report.nodes ?? [])
        .map((node) => node.node)
        .filter((node): node is string => typeof node === 'string'),
      sources: planSources(settings.workspace, context.root),
      restartBusy: options.restartBusy === true,
    },
    context.run
  );
  return {
    ...outcome,
    data: { ...(outcome.data as object), plan },
    text: [outcome.text, planText(plan)].filter(Boolean).join('\n'),
  };
}

interface ApplyContext {
  settings: Settings;
  run: Runner;
  revision: string;
  /** How the fleet state stood with the bucket when this run started. */
  standing: Standing;
}

/** Applies without a confirmation prompt; --dry-run is the preview. */
async function authorizeAndApply(
  root: string,
  state: Enrollment | null,
  options: FleetSyncOptions,
  context: ApplyContext
): Promise<CommandOutcome> {
  const { settings, run, revision } = context;
  const request = { ...options, revision, apply: true, yes: true };
  if (!interactive(options)) return applyLocked(root, state, request, context);
  await enrollManager(settings.config, run);
  // Needed to hand each node its own Vault token; nodes report any gap.
  await authorizeManager({ interactive: true }, run);
  return applyLocked(
    root,
    state,
    { ...request, interactiveAuthorization: true },
    context
  );
}

/** Records the approved revision, converges, records what was applied, then
 * uploads the fleet state: the report says whether the bucket holds it.
 */
function applyLocked(
  root: string,
  state: Enrollment | null,
  request: FleetSyncOptions & { revision: string },
  context: ApplyContext
): Promise<CommandOutcome> {
  const { settings, run, revision } = context;
  const record = runRecord(state, revision, {
    context: { ...stateContext(run), takeOver: request.takeOver === true },
    standing: context.standing,
    ...(definitionSource().kind === 'file'
      ? { definition: JSON.stringify(canonicalDefinition, null, 2) + '\n' }
      : {}),
  });
  return withMachineLock(root, async () => {
    record.approve();
    try {
      return await selected(
        { ...request, rolledOut: state?.appliedRevision === revision },
        settings,
        run,
        (report) => record.settle(report.ok, appliedRevisions(report))
      );
    } finally {
      await record.abandon();
    }
  }).catch((error: unknown) => {
    if (error instanceof FleetLockError)
      return actionRequired(
        'FLEET_MANAGER_LOCKED',
        'Another manager run or interrupted lock exists. Inspect manager and remote processes before removing an abandoned sync.lock; never steal active package-manager locks.'
      );
    throw error;
  });
}
/** Every run (previews and schedules too) happens on the manager: a worker can
 * neither converge the manager's singletons nor observe its T3 links, so a
 * partial run there only produces misleading failures.
 */
async function onManager(run: Runner): Promise<boolean> {
  const { manager } = canonicalDefinition;
  return (await managerIdentity(manager.id, run)).status === 'pass';
}

/** Hands the request to the manager; refuses (without touching any worker)
 * when hand-off is disabled, e.g. on the manager side of a hand-off.
 */
async function offManager(
  options: FleetSyncOptions,
  settings: Settings,
  run: Runner,
  forward: ForwardSpawn | undefined
): Promise<CommandOutcome> {
  const definition = canonicalDefinition;
  // Only the manager's fleet state knows the revision applied before.
  if (options.rollback)
    return actionRequired(
      'FLEET_NOT_MANAGER',
      `fleet-sync --rollback runs only on the manager (${definition.manager.id}); nothing was changed.`
    );
  const revision =
    options.revision ??
    packageRevision() ??
    (await localCheckoutRevision(settings.workspace, run));
  if (forwardingDisabled())
    return actionRequired(
      'FLEET_NOT_MANAGER',
      `fleet-sync runs only on the manager (${definition.manager.id}), which is always a macOS machine; nothing was changed. Run it there, or from a worker that can SSH to the manager.`,
      revision ?? null
    );
  const runScript = revision
    ? await managerRunScript(settings.workspace, revision, run)
    : null;
  return forwardToManager(definition, options, revision, {
    spawn: forward,
    script: runScript,
  });
}

function scheduleStatus(
  settings: Settings,
  run: Runner
): Promise<CommandOutcome> {
  return managerSchedule(
    {
      action: 'status',
      revision: '',
      config: settings.config,
      authorized: false,
    },
    run
  );
}

function actionRequired(
  code: string,
  remedy: string,
  revision: string | null = null
): CommandOutcome {
  const report = managerFailure(canonicalDefinition, revision, code, remedy);
  return {
    exitCode: 1,
    data: report,
    text: managerText(report, { color: stdoutColor() }),
  };
}

function validate(options: FleetSyncOptions): void {
  validateSchedule(options.schedule);
  if (options.all && options.node?.length)
    throw new FleetUsageError('Choose --all or --node, not both.');
  if (options.revision !== undefined && !isRevision(options.revision))
    throw new FleetUsageError(
      '--revision requires an exact lowercase 40-character commit SHA.'
    );
  validateOnly(options);
  validateRollback(options);
  if (options.restartBusy && (options.only || options.schedule))
    throw new FleetUsageError(
      '--restart-busy applies to one full sync: it takes neither --only nor --schedule.'
    );
  if (options.dryRun && (options.apply || options.yes))
    throw new FleetUsageError(
      '--dry-run cannot be combined with apply confirmation.'
    );
}
function validateRollback(options: FleetSyncOptions): void {
  if (!options.rollback) return;
  if (options.revision !== undefined || options.schedule)
    throw new FleetUsageError(
      '--rollback chooses the revision itself: drop --revision and --schedule.'
    );
  if (options.only)
    throw new FleetUsageError(
      '--rollback converges the whole fleet; it takes no --only.'
    );
}

function validateOnly(options: FleetSyncOptions): void {
  if (options.only !== undefined && options.only !== 'accounts')
    throw new FleetUsageError('--only takes one scope: accounts.');
  if (options.only && (options.dryRun || options.schedule))
    throw new FleetUsageError(
      '--only accounts applies at once; it takes neither --dry-run nor --schedule.'
    );
}

/** `--only accounts`: workers keep the revision they run; only their
 * accounts change.
 */
async function onlyAccounts(
  options: FleetSyncOptions,
  settings: Settings,
  run: Runner
): Promise<CommandOutcome> {
  const root = machineRoot();
  await ensurePrivateRoot(root);
  const state = await loadEnrollment(legacyHome() ? root : null);
  const revision =
    state?.approvedRevision ??
    (await selectedRevision(options.revision, undefined, settings, run));
  if (!isRevision(revision))
    return actionRequired(
      'FLEET_REVISION_REQUIRED',
      'No revision is applied yet. Run a full fleet-sync first.'
    );
  return syncAccounts(options, settings, { revision, run });
}

function interactive(options: FleetSyncOptions): boolean {
  return (
    ![
      options.dryRun,
      options.apply,
      options.yes,
      options.json,
      options.nonInteractive,
      process.env['CI'],
    ].some(Boolean) && Boolean(process.stdin.isTTY && process.stderr.isTTY)
  );
}

/** The commit an installed package was published from: the version of
 * dev-fleet you run is the revision the fleet moves to.
 */
function packageRevision(): string | undefined {
  return packageInfo().revision ?? undefined;
}

async function scheduleRequest(
  options: FleetSyncOptions,
  revision: string,
  settings: Settings,
  run: Runner
): Promise<CommandOutcome> {
  const root = machineRoot();

  if (options.dryRun)
    return actionRequired(
      'FLEET_SCHEDULE_PREVIEW',
      'No schedule changed. Inspect --schedule status; scheduling writes require --apply --yes.'
    );
  if (!options.apply || !options.yes)
    return managerSchedule(
      {
        action: options.schedule!,
        revision,
        config: settings.config,
        authorized: false,
      },
      run
    );
  return withMachineLock(root, () =>
    managerSchedule(
      {
        action: options.schedule!,
        revision,
        config: settings.config,
        authorized: Boolean(options.apply && options.yes),
      },
      run
    )
  );
}

function validateSchedule(schedule: unknown): void {
  if (
    schedule !== undefined &&
    !['enable', 'pause', 'resume', 'disable', 'status'].includes(
      String(schedule)
    )
  )
    throw new FleetUsageError('Unknown manager schedule action.');
}

/** The revision a request names: --revision, or for --rollback the one
 * applied before the current one (null when the fleet state records none).
 */
function requestedRevision(
  options: FleetSyncOptions,
  state: { previousRevision?: string } | null
): string | undefined | null {
  if (!options.rollback) return options.revision;
  return state?.previousRevision ?? null;
}

async function selectedRevision(
  explicit: string | undefined,
  approved: string | undefined,
  settings: Settings,
  run: Runner
): Promise<string | undefined> {
  return (
    explicit ??
    packageRevision() ??
    (await localCheckoutRevision(settings.workspace, run)) ??
    approved
  );
}

/** The revision each worker holds after this run, for the fleet state: a
 * worker that converged keeps its progress even when the fleet is not ready.
 */
function appliedRevisions(report: ManagerReport): Record<string, string> {
  return Object.fromEntries(
    report.nodes
      .filter((node) => node.role !== 'manager' && node.appliedRevision)
      .map((node) => [node.node, node.appliedRevision!])
  );
}
