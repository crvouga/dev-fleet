import { record } from '../config';
import { databasePath, stateRoot } from './paths';
import { readDocument, writeDocument } from './store';

/** Who started a fleet-sync run: a person (or an agent) at the manager, or
 * the manager's own schedule.
 */
export type Trigger = 'operator' | 'schedule';

/** One fleet-sync run, as the history keeps it: codes and node names only,
 * never a remedy, a path or anything a subprocess printed.
 */
export interface SyncRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: Trigger;
  revision: string | null;
  ok: boolean;
  exitCode: number;
  /** The IDs of the checks that failed, once each. */
  failing: string[];
  /** The machines that were not ready when the run ended. */
  notReady: string[];
}

/** The schedule the manager was last told to keep. */
export interface ScheduleRecord {
  enabled: boolean;
  intervalSeconds: number;
  changedAt: string;
}

export interface History {
  version: 1;
  schedule?: ScheduleRecord;
  runs: SyncRun[];
}

/** The history is capped twice: by age and by count, so the document stays
 * far below the fleet state's limit on one document.
 */
export const HISTORY_DAYS = 90;
export const HISTORY_RUNS = 500;

const DAY_MS = 86_400_000;

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function syncRun(value: unknown): value is SyncRun {
  return (
    record(value) &&
    typeof value['startedAt'] === 'string' &&
    typeof value['finishedAt'] === 'string' &&
    typeof value['durationMs'] === 'number' &&
    (value['trigger'] === 'operator' || value['trigger'] === 'schedule') &&
    (value['revision'] === null || typeof value['revision'] === 'string') &&
    typeof value['ok'] === 'boolean' &&
    typeof value['exitCode'] === 'number' &&
    strings(value['failing']) &&
    strings(value['notReady'])
  );
}

function scheduleRecord(value: unknown): value is ScheduleRecord {
  return (
    record(value) &&
    typeof value['enabled'] === 'boolean' &&
    typeof value['intervalSeconds'] === 'number' &&
    typeof value['changedAt'] === 'string'
  );
}

/** A document that cannot be read is an empty history: it only ever
 * describes the past, and the next run starts it again.
 */
export function parseHistory(text: string | null): History {
  let value: unknown = null;
  try {
    value = text === null ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  if (!record(value) || value['version'] !== 1) return { version: 1, runs: [] };
  return {
    version: 1,
    ...(scheduleRecord(value['schedule'])
      ? { schedule: value['schedule'] }
      : {}),
    runs: Array.isArray(value['runs']) ? value['runs'].filter(syncRun) : [],
  };
}

export function readHistory(env = process.env): History {
  return parseHistory(readDocument(databasePath(stateRoot(env)), 'history'));
}

function writeHistory(history: History, env: NodeJS.ProcessEnv): void {
  writeDocument(
    databasePath(stateRoot(env)),
    'history',
    JSON.stringify(history) + '\n'
  );
}

/** Keeps the runs of the last HISTORY_DAYS days, and at most HISTORY_RUNS. */
export function capped(runs: SyncRun[], now: Date): SyncRun[] {
  const oldest = now.getTime() - HISTORY_DAYS * DAY_MS;
  return runs
    .filter((run) => Date.parse(run.finishedAt) >= oldest)
    .slice(-HISTORY_RUNS);
}

export function appendRun(
  run: SyncRun,
  env = process.env,
  now = new Date()
): History {
  const history = readHistory(env);
  const next = { ...history, runs: capped([...history.runs, run], now) };
  writeHistory(next, env);
  return next;
}

export function recordSchedule(
  schedule: ScheduleRecord,
  env = process.env
): void {
  writeHistory({ ...readHistory(env), schedule }, env);
}

/** What a fleet-sync report says about one run. */
export function summarizeRun(
  data: unknown,
  timing: { startedAt: Date; finishedAt: Date },
  trigger: Trigger,
  exitCode: number
): SyncRun {
  const report = record(data) ? data : {};
  const checks = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(record) : [];
  const nodes = checks(report['nodes']);
  const failing = new Set<string>();
  for (const check of [
    ...checks(report['checks']),
    ...nodes.flatMap((node) => checks(node['checks'])),
  ])
    if (check['status'] === 'fail' && typeof check['id'] === 'string')
      failing.add(check['id']);
  const notReady = nodes
    .filter((node) =>
      checks(node['checks']).some((check) => check['status'] === 'fail')
    )
    .map((node) => node['node'])
    .filter((node): node is string => typeof node === 'string');
  return {
    startedAt: timing.startedAt.toISOString(),
    finishedAt: timing.finishedAt.toISOString(),
    durationMs: timing.finishedAt.getTime() - timing.startedAt.getTime(),
    trigger,
    revision:
      typeof report['desiredRevision'] === 'string'
        ? report['desiredRevision']
        : null,
    ok: exitCode === 0 && report['ok'] !== false,
    exitCode,
    failing: [...failing].sort(),
    notReady: [...new Set(notReady)].sort(),
  };
}
