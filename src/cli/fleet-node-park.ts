import type { FleetDefinition, MachineDefinition } from '../definition';
import { FleetUsageError } from '../errors';
import { fleet } from '../fleet-config';
import { makeReport, renderReport } from '../report';
import { runCommand } from '../runner';
import { changeWorkers, readWorkerStates } from '../state/workers';
import { stateContext, type StateContext } from '../state/sync';
import type { Check, Runner } from '../types';
import { duration, workerActivity } from '../worker-activity';
import type { CommandOutcome } from './contracts';
import { readRoster } from './roster';

export interface NodeParkOptions {
  id?: string;
  /** Park although agent turns are under way, or cannot be counted. */
  force?: boolean;
  dryRun?: boolean;
}

export interface NodeParkServices {
  run: Runner;
  /** The roster: the fleet state's, or a file `--config` names. */
  roster: string;
  definition: () => FleetDefinition;
  state: () => StateContext;
  now: () => Date;
  /** A normal fleet-sync of one worker, which verifies it. */
  sync: (id: string) => Promise<CommandOutcome>;
}

export function parkServices(
  roster: string,
  sync: (id: string) => Promise<CommandOutcome>
): NodeParkServices {
  return {
    run: runCommand,
    roster,
    definition: () => fleet,
    state: () => stateContext(runCommand),
    now: () => new Date(),
    sync,
  };
}

/** A hook may start or stop a machine through an infrastructure tool; it
 * gets half an hour.
 */
const HOOK_TIMEOUT_MS = 1_800_000;

function declared(definition: FleetDefinition, id: string | undefined) {
  const worker = definition.workers.find((entry) => entry.id === id);
  if (!worker)
    throw new FleetUsageError('--id must name a worker fleet.json declares.');
  return worker;
}

function outcome(
  command: string,
  id: string,
  checks: Check[],
  extra: Record<string, unknown> = {}
): CommandOutcome {
  const report = { ...makeReport(command, [{ node: id, checks }]), ...extra };
  return {
    exitCode: checks.some((check) => check.status === 'fail') ? 1 : 0,
    data: report,
    text: renderReport(report),
  };
}

/** Runs the declared stop or start command with the worker ID last. */
async function hook(
  worker: MachineDefinition,
  which: 'stop' | 'start',
  definition: FleetDefinition,
  run: Runner
): Promise<Check | null> {
  const command = definition.parking?.[which];
  if (!command) return null;
  const result = await run([...command, worker.id], {
    timeoutMs: HOOK_TIMEOUT_MS,
  });
  return result.ok
    ? {
        id: 'worker:park-hook',
        status: 'pass',
        summary: `The declared ${which} command ran for ${worker.id}.`,
      }
    : {
        id: 'worker:park-hook',
        status: 'fail',
        summary:
          which === 'stop'
            ? 'WORKER_STOP_HOOK_FAILED'
            : 'WORKER_START_HOOK_FAILED',
        remedy: {
          action: `The ${which} command parking.${which} in fleet.json names failed for ${worker.id}, so its state was not changed. Run it by hand to see why, then run this command again.`,
        },
      };
}

/** Why a worker must not be parked now, unless forced: agent turns under
 * way, or a worker that answers but whose turns cannot be counted. A worker
 * that does not answer is off already.
 */
async function busy(
  worker: MachineDefinition,
  services: NodeParkServices
): Promise<Check | null> {
  const node = (await readRoster(services.roster))?.nodes.find(
    (entry) => entry.id === worker.id
  );
  const activity = node ? await workerActivity(node, services.run) : null;
  if (!activity || activity.runningSessions === 0) return null;
  return {
    id: 'worker:parked',
    status: 'fail',
    summary:
      activity.runningSessions === null
        ? 'WORKER_ACTIVITY_UNREADABLE'
        : 'WORKER_BUSY',
    remedy: {
      action:
        activity.runningSessions === null
          ? `${worker.id}'s T3 could not say whether agent turns are under way, so it was not parked. Look at it, then repeat with --force to park it anyway.`
          : `${worker.id} runs ${activity.runningSessions} agent turn(s); stopping it would end them. Wait for them to finish, or repeat with --force.`,
    },
  };
}

/** Parks a worker: it is stopped or destroyed on purpose, so it is no longer
 * contacted, never the canary and does not fail the fleet. Refuses while
 * agent turns run on it, unless --force. Runs the declared stop command.
 */
export async function fleetNodePark(
  options: NodeParkOptions,
  services: NodeParkServices
): Promise<CommandOutcome> {
  const definition = services.definition();
  const worker = declared(definition, options.id);
  const parkedAt = readWorkerStates().workers[worker.id]?.parkedAt;
  if (parkedAt)
    return outcome('fleet-node-park', worker.id, [
      {
        id: 'worker:parked',
        status: 'pass',
        summary: `${worker.id} is parked since ${parkedAt}.`,
      },
    ]);
  if (!options.force) {
    const refused = await busy(worker, services);
    if (refused) return outcome('fleet-node-park', worker.id, [refused]);
  }
  if (options.dryRun)
    return outcome('fleet-node-park', worker.id, [
      {
        id: 'worker:parked',
        status: 'skip',
        summary: `Planned: ${definition.parking?.stop ? 'run the declared stop command and ' : ''}park ${worker.id}.`,
      },
    ]);
  const stopped = await hook(worker, 'stop', definition, services.run);
  if (stopped?.status === 'fail')
    return outcome('fleet-node-park', worker.id, [stopped]);
  const at = services.now().toISOString();
  await changeWorkers(services.state(), (current) => ({
    [worker.id]: { ...current[worker.id], parkedAt: at },
  }));
  return outcome('fleet-node-park', worker.id, [
    ...(stopped ? [stopped] : []),
    {
      id: 'worker:parked',
      status: 'pass',
      summary: `${worker.id} is parked since ${at}: fleet-sync and fleet-status no longer contact it.`,
    },
  ]);
}

/** Brings a parked worker back: runs the declared start command, marks it
 * active, then runs a normal fleet-sync of that worker, which verifies it.
 * The exit code is the sync's.
 */
export async function fleetNodeResume(
  options: NodeParkOptions,
  services: NodeParkServices
): Promise<CommandOutcome> {
  const definition = services.definition();
  const worker = declared(definition, options.id);
  const parkedAt = readWorkerStates().workers[worker.id]?.parkedAt;
  if (options.dryRun)
    return outcome('fleet-node-resume', worker.id, [
      {
        id: 'worker:parked',
        status: 'skip',
        summary: parkedAt
          ? `Planned: ${definition.parking?.start ? 'run the declared start command, ' : ''}mark ${worker.id} active and run fleet-sync --node ${worker.id}.`
          : `Planned: ${worker.id} is active already; run fleet-sync --node ${worker.id}.`,
      },
    ]);
  const checks: Check[] = [];
  if (parkedAt) {
    const started = await hook(worker, 'start', definition, services.run);
    if (started?.status === 'fail')
      return outcome('fleet-node-resume', worker.id, [started]);
    if (started) checks.push(started);
    await changeWorkers(services.state(), (current) => {
      const { parkedAt: _parked, ...rest } = current[worker.id] ?? {};
      return { [worker.id]: rest };
    });
    const since = (services.now().getTime() - Date.parse(parkedAt)) / 1000;
    checks.push({
      id: 'worker:parked',
      status: 'pass',
      summary: `${worker.id} is active again after ${duration(Math.max(0, since))} parked.`,
    });
  }
  const synced = await services.sync(worker.id);
  const report = synced.data as { ok?: boolean };
  checks.push(
    synced.exitCode === 0 && report.ok !== false
      ? {
          id: 'rollout:node',
          status: 'pass',
          summary: `fleet-sync --node ${worker.id} converged and verified it.`,
        }
      : {
          id: 'rollout:node',
          status: 'fail',
          summary: 'WORKER_RESUME_FAILED',
          remedy: {
            action: `fleet-sync --node ${worker.id} did not end ready; its report (sync in this output) says why. Fix that, then run devfleet fleet-sync --node ${worker.id}.`,
          },
        }
  );
  return outcome('fleet-node-resume', worker.id, checks, {
    sync: synced.data,
  });
}
