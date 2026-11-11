import { localCheckoutRevision } from '../machine/local-source';
import { fleet as canonicalDefinition, reloadFleet } from '../fleet-config';
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
  DIVERGED_REMEDY,
  refresh,
  stateContext,
  type Standing,
} from '../state/sync';
import { runRecord } from './fleet-sync-state';
import { runCommand } from '../runner';
import type { Runner } from '../types';
import type { Settings } from './settings';
import type { CommandOutcome } from './contracts';
import { FleetUsageError } from '../errors';
import { FleetLockError } from '../machine/lock-error';
import { selected } from './fleet-sync-remote';
import { managerIdentity } from './fleet-sync-manager';
import { trackedScript } from '../remote-bootstrap';
import { rehome } from './fleet-sync-checkout';
import {
  forwardingDisabled,
  forwardToManager,
  type ForwardSpawn,
} from './fleet-sync-forward';

declare const PERSONAL_SOURCE_REVISION: string | null;
export interface FleetSyncOptions {
  revision?: string;
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  node?: string[];
  all?: boolean;
  schedule?: ScheduleAction;
  /** Internal: this revision already converged the whole fleet, so no canary
   * has to prove it first and every worker converges at once.
   */
  rolledOut?: boolean;
  /** Internal: set for interactive terminal runs (sudo enrollment prompts). */
  interactiveAuthorization?: boolean;
  expectedPlanFingerprint?: string;
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
  return managerSync(options, settings, {
    run,
    root: machineRoot(),
    restart: () => fleetSync(options, settings, run, forward),
  });
}

export interface ManagerSync {
  run: Runner;
  /** This machine's run lock and caches. */
  root: string;
  /** Starts the request over once the fleet state has been replaced. */
  restart: () => Promise<CommandOutcome>;
}

/** fleet-sync on the machine already known to be the manager. */
export async function managerSync(
  options: FleetSyncOptions,
  settings: Settings,
  { run, root, restart }: ManagerSync
): Promise<CommandOutcome> {
  await ensurePrivateRoot(root);
  const state = await loadEnrollment(legacyHome() ? root : null);
  const revision = await selectedRevision(
    options.revision,
    state?.approvedRevision,
    settings,
    run
  );
  if (!isRevision(revision))
    return actionRequired(
      'FLEET_REVISION_REQUIRED',
      'Select an approved full SHA with --revision, or use a published package containing clean source provenance.'
    );
  if (options.schedule)
    return scheduleRequest(options, revision, settings, run);
  const rehomed = await rehome(
    options,
    { revision, workspace: settings.workspace },
    run
  );
  if (rehomed) return rehomed;
  if (options.dryRun) return selected({ ...options, revision }, settings, run);
  // The bucket is the source of truth: a run starts from its version of the
  // configuration, the roster and the approval, not from a stale local copy.
  const fresh = await refresh(stateContext(run));
  if (fresh.standing === 'diverged')
    return actionRequired('FLEET_STATE_DIVERGED', DIVERGED_REMEDY, revision);
  if (fresh.replaced) {
    // Everything read so far came from the stale copy, the manager's own
    // identity included.
    reloadFleet();
    return restart();
  }
  return authorizeAndApply(root, state, options, {
    settings,
    run,
    revision,
    standing: fresh.standing,
  });
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
    context: stateContext(run),
    standing: context.standing,
  });
  return withMachineLock(root, async () => {
    record.approve();
    try {
      return await selected(
        { ...request, rolledOut: state?.appliedRevision === revision },
        settings,
        run,
        (report) => record.settle(report.ok)
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
  const revision =
    options.revision ??
    packageRevision() ??
    (await localCheckoutRevision(settings.workspace, run));
  if (forwardingDisabled())
    return actionRequired(
      'FLEET_NOT_MANAGER',
      `fleet-sync runs only on the manager (${definition.manager.id}); nothing was changed. Run it there, or from a worker that can SSH to the manager.`,
      revision ?? null
    );
  const runScript = revision
    ? await trackedScript(
        settings.workspace,
        revision,
        'bootstrap/fleet-manager-run.sh',
        run
      )
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
  if (options.dryRun && (options.apply || options.yes))
    throw new FleetUsageError(
      '--dry-run cannot be combined with apply confirmation.'
    );
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

function packageRevision(): string | undefined {
  return typeof PERSONAL_SOURCE_REVISION === 'string'
    ? PERSONAL_SOURCE_REVISION
    : undefined;
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
