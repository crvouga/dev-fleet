import { record } from './config';
import type { FleetDefinition, MachineDefinition } from './definition';
import { sshArgs } from './ssh';
import type { Check, FleetNode, Runner } from './types';

/** How long a worker has been up and what its agents are doing, as T3
 * records it: the number of agent turns under way and when the last one was
 * requested or ended. Never the content of a session.
 */
export interface WorkerActivity {
  uptimeSeconds: number | null;
  runningSessions: number | null;
  lastActivityAt: string | null;
}

/** One worker in fleet-status: active or parked, what it does, and what it
 * costs while it runs (only what fleet.json declares).
 */
export interface WorkerUsage extends Partial<WorkerActivity> {
  id: string;
  state: 'active' | 'parked';
  parkedAt?: string;
  reachable?: boolean;
  /** Seconds since the last agent activity, or since boot without any. */
  idleSeconds?: number;
  idle?: boolean;
  hourlyRate?: number;
  currency?: string;
  billingNote?: string;
}

/** The installed copy fleet-sync keeps outside every revision
 * (ansible/ubuntu/tasks/recovery.yml).
 */
export const ACTIVITY_PROBE =
  'cut -d" " -f1 /proc/uptime; python3 -I -B /usr/local/lib/personal-fleet/t3-idle.py --state "${T3CODE_HOME:-$HOME/.t3}/userdata/statev2.sqlite" --activity';

/** Reads a worker's uptime and agent activity over SSH; null when the
 * worker did not answer.
 */
export async function workerActivity(
  node: FleetNode,
  run: Runner
): Promise<WorkerActivity | null> {
  const result = await run([...sshArgs(node), ACTIVITY_PROBE], {
    timeoutMs: 20_000,
  });
  if (!result.ok && !result.stdout) return null;
  return parseActivity(result.stdout);
}

/** The JSON line of t3-idle.py --activity, or nothing known. */
function activityLine(line: string | undefined): Record<string, unknown> {
  let answer: unknown = null;
  try {
    answer = JSON.parse(line ?? '');
  } catch {
    answer = null;
  }
  return record(answer) && answer['version'] === 1 && !answer['unknown']
    ? answer
    : {};
}

/** What the probe printed: the uptime, then the one JSON line of
 * t3-idle.py --activity. Anything unreadable is unknown, never zero.
 */
export function parseActivity(stdout: string): WorkerActivity {
  const [uptime, line] = stdout.split('\n');
  const seconds = Number(uptime);
  const known = activityLine(line);
  const running = known['running'];
  const last = known['lastActivity'];
  return {
    uptimeSeconds:
      uptime && Number.isFinite(seconds) && seconds >= 0
        ? Math.floor(seconds)
        : null,
    runningSessions:
      Number.isInteger(running) && Number(running) >= 0
        ? (running as number)
        : null,
    lastActivityAt:
      typeof last === 'string' && !Number.isNaN(Date.parse(last))
        ? new Date(last).toISOString()
        : null,
  };
}

/** `2d 3h`, `5h 12m`, `40m`: a duration for a person. */
export function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** Seconds since the last agent activity, or since boot when there was
 * none; null when it cannot be told.
 */
function idleFor(activity: WorkerActivity, now: Date): number | null {
  if (activity.lastActivityAt)
    return Math.max(
      0,
      Math.floor((now.getTime() - Date.parse(activity.lastActivityAt)) / 1000)
    );
  return activity.uptimeSeconds;
}

/** `worker:idle`: a warning once a worker has run no agent turn for longer
 * than fleet.json's parking.idleAfterHours. A worker with a turn under way
 * is never idle, and one whose T3 cannot be read is not judged.
 */
export function idleCheck(
  id: string,
  activity: WorkerActivity,
  idleAfterHours: number | undefined,
  now: Date
): { check: Check; idleSeconds?: number; idle: boolean } {
  if (activity.runningSessions === null)
    return {
      idle: false,
      check: {
        id: 'worker:idle',
        status: 'skip',
        summary: `${id}'s agent activity could not be read from its T3.`,
      },
    };
  if (activity.runningSessions > 0)
    return {
      idle: false,
      idleSeconds: 0,
      check: {
        id: 'worker:idle',
        status: 'pass',
        summary: `${id} runs ${activity.runningSessions} agent turn(s).`,
      },
    };
  const seconds = idleFor(activity, now);
  const limit = idleAfterHours === undefined ? null : idleAfterHours * 3600;
  const idle = seconds !== null && limit !== null && seconds > limit;
  return {
    idle,
    ...(seconds === null ? {} : { idleSeconds: seconds }),
    check: idle
      ? {
          id: 'worker:idle',
          status: 'warn',
          summary: `${id} has run no agent turn for ${duration(seconds!)}, longer than the declared ${idleAfterHours}h.`,
          remedy: {
            action: `Park it while nobody needs it: devfleet fleet-node-park --id ${id}. devfleet fleet-node-resume --id ${id} brings it back.`,
          },
        }
      : {
          id: 'worker:idle',
          status: 'pass',
          summary:
            seconds === null
              ? `${id} runs no agent turn.`
              : `${id} runs no agent turn; the last agent activity was ${duration(seconds)} ago.`,
        },
  };
}

function billing(worker: MachineDefinition | undefined) {
  return worker?.billing
    ? {
        hourlyRate: worker.billing.hourlyRate,
        ...(worker.billing.currency
          ? { currency: worker.billing.currency }
          : {}),
        ...(worker.billing.note ? { billingNote: worker.billing.note } : {}),
      }
    : {};
}

/** Measures every active enrolled worker and lists the parked ones: the
 * `workers` of fleet-status, and the checks it adds to each worker's report.
 * Parked workers are not contacted.
 */
export async function fleetUsage(
  definition: FleetDefinition,
  {
    nodes,
    parked,
    run,
    now,
  }: {
    nodes: FleetNode[];
    parked: Record<string, string>;
    run: Runner;
    now: Date;
  }
): Promise<{ workers: WorkerUsage[]; checks: Map<string, Check> }> {
  const checks = new Map<string, Check>();
  const workers = await Promise.all(
    definition.workers.map(async (worker): Promise<WorkerUsage> => {
      if (parked[worker.id])
        return {
          id: worker.id,
          state: 'parked',
          parkedAt: parked[worker.id]!,
          ...billing(worker),
        };
      const node = nodes.find((entry) => entry.id === worker.id);
      const activity = node ? await workerActivity(node, run) : null;
      if (!activity)
        return {
          id: worker.id,
          state: 'active',
          reachable: false,
          ...billing(worker),
        };
      const judged = idleCheck(
        worker.id,
        activity,
        definition.parking?.idleAfterHours,
        now
      );
      checks.set(worker.id, judged.check);
      return {
        id: worker.id,
        state: 'active',
        reachable: true,
        ...activity,
        ...(judged.idleSeconds === undefined
          ? {}
          : { idleSeconds: judged.idleSeconds }),
        idle: judged.idle,
        ...billing(worker),
      };
    })
  );
  return { workers, checks };
}

/** Workers running, workers idle, and what the idle ones cost per day, by
 * the rates fleet.json declares.
 */
export function usageSummary(workers: WorkerUsage[]) {
  const running = workers.filter(
    (worker) => worker.state === 'active' && worker.reachable
  );
  const idle = running.filter((worker) => worker.idle);
  const currencies = [
    ...new Set(idle.flatMap((worker) => worker.currency ?? [])),
  ];
  return {
    running: running.length,
    idle: idle.length,
    parked: workers.filter((worker) => worker.state === 'parked').length,
    idleCostPerDay:
      Math.round(
        idle.reduce((sum, worker) => sum + (worker.hourlyRate ?? 0) * 24, 0) *
          100
      ) / 100,
    ...(currencies.length === 1 ? { currency: currencies[0] } : {}),
  };
}

/** The lines fleet-status prints about each worker and the fleet. */
export function usageText(workers: WorkerUsage[], now: Date): string {
  const summary = usageSummary(workers);
  const lines = workers.map((worker) => {
    if (worker.state === 'parked')
      return `  ${worker.id}: parked for ${duration(Math.max(0, (now.getTime() - Date.parse(worker.parkedAt!)) / 1000))}`;
    if (!worker.reachable) return `  ${worker.id}: not reached`;
    const parts = [
      worker.uptimeSeconds == null
        ? 'uptime unknown'
        : `up ${duration(worker.uptimeSeconds)}`,
      worker.runningSessions == null
        ? 'agent turns unknown'
        : `${worker.runningSessions} agent turn(s) running`,
      worker.lastActivityAt
        ? `last agent activity ${worker.lastActivityAt}`
        : 'no agent activity recorded',
    ];
    if (worker.idle) parts.push('idle');
    if (worker.hourlyRate !== undefined)
      parts.push(
        `${worker.hourlyRate}${worker.currency ? ` ${worker.currency}` : ''}/h`
      );
    return `  ${worker.id}: ${parts.join(', ')}`;
  });
  return [
    'Workers:',
    ...lines,
    `${summary.running} running, ${summary.idle} idle, ${summary.parked} parked; idle workers cost ${summary.idleCostPerDay}${summary.currency ? ` ${summary.currency}` : ''} per day as declared.`,
  ].join('\n');
}

/** A report's text, followed by the worker lines when there are any. */
export function withUsage(
  text: string,
  usage: { workers: WorkerUsage[] } | null
): string {
  return usage?.workers.length
    ? `${text}\n${usageText(usage.workers, new Date())}`
    : text;
}
