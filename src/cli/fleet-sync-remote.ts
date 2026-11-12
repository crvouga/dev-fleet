import { createHash } from 'node:crypto';
import { IDES } from '../ide';
import { enabled, workerChecks } from '../ide/orchestrate';
import { idesOf } from '../ide/definition';
import { rememberEnvironment } from '../t3/pairing';
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
import type { FleetDefinition } from '../definition';
import { fleet as definition } from '../fleet-config';
import { synchronizeManager } from '../manager-sync';
import { inspectBootstrap } from '../manager-sync';
import { prepareBootstrap, bootstrapRemote } from '../remote-bootstrap';
import { machineRoot } from './fleet-sync';
import type { Check, Runner } from '../types';
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
  let roster;
  try {
    roster = enrolledRoster(canonical, await loadRoster(settings.config));
  } catch {
    return enrollmentRequired(canonical, options.revision);
  }
  const nodes = selectNodes(roster, options.node ?? []);
  const scoped = scopeDefinition(canonical, options.node);
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
  const payload = options.apply
    ? await prepareBootstrap(machineRoot(), options.revision, run, {
        definition: canonical,
        checkout: settings.workspace,
      })
    : null;
  const started = Date.now();
  const report = await synchronizeManager(
    {
      definition: scoped,
      nodes,
      revision: options.revision,
      apply: Boolean(options.apply),
      ...canary(canonical, options),
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
    })
  ).finally(() => ui.progress.stop());
  if (settle) report.checks.push(await settle(report));
  return outcome(report, planFingerprint, started);
}

/** A revision new to the fleet is proven on the first declared worker before
 * the rest; repeating one that already converged everywhere needs no canary,
 * so every worker converges at once.
 */
function canary(
  canonical: FleetDefinition,
  options: FleetSyncOptions
): { canary?: string } {
  const first = canonical.workers[0];
  return first && !options.rolledOut ? { canary: first.id } : {};
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
  }
): DeployNode {
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
    // Password prompts need a quiet terminal: no spinner while authorizing.
    if (ui.interactiveAuthorization) {
      ui.progress.stop();
      const checks = await authorizePrivilege(node, payload.authorizeSudo, run);
      if (checks.length) return { node: node.id, checks };
    }
    const vault = { interactive: ui.interactiveAuthorization };
    if (ui.interactiveAuthorization) ui.progress.stop();
    const before = await authorizeVault(node, vault, run);
    ui.progress.step(node.id, 'Converging (remote lock, install, verify)');
    const result = await bootstrapRemote(node, payload, run, {
      progress: (line) => ui.progress.step(node.id, line),
    });
    // A fresh node gets vault from the bootstrap; log it in now. Its provider
    // checks in this run predate the login, so the next sync verifies them.
    result.checks.push(
      ...(before.length ? before : await authorizeVault(node, vault, run))
    );
    // Workers are Linux by definition.
    ui.progress.step(node.id, 'Verifying SSH, OS and T3');
    result.checks.push(...(await inspectBootstrap(node, run, 'linux')));
    result.checks.push(
      ...(await workerChecks(enabled(idesOf(canonical), IDES), node, {
        run,
        workspace: ui.workspace,
        earlier: result.checks,
        remember: async (id, identity) => {
          await rememberEnvironment(ui.roster, id, identity);
        },
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
    interactiveAuthorization: Boolean(
      options.interactiveAuthorization &&
      !options.json &&
      !options.nonInteractive
    ),
  };
}
