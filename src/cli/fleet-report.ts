import { FleetUsageError } from '../errors';
import { readHistory, type SyncRun } from '../state/history';
import type { CommandOutcome } from './contracts';

export interface FleetReportOptions {
  since?: string;
  json?: boolean;
}

const UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `30d`, `12h` or `90m`: how far back the report looks. */
export function parseSince(value = '30d'): number {
  const match = /^([1-9]\d{0,4})([mhd])$/.exec(value);
  if (!match)
    throw new FleetUsageError(
      '--since takes a duration such as 30d, 12h or 90m.'
    );
  return Number(match[1]) * UNITS[match[2]!]!;
}

export interface Reliability {
  runs: number;
  succeeded: number;
  successRate: number | null;
  meanDurationMs: number | null;
  failingChecks: { id: string; runs: number }[];
  notReady: { node: string; ms: number }[];
}

/** How long each machine was not ready: from the end of a run that left it
 * not ready to the end of the next run that found it ready (or until now).
 */
function notReadyTime(runs: SyncRun[], now: Date): Map<string, number> {
  const since = new Map<string, number>();
  const total = new Map<string, number>();
  const add = (node: string, until: number) => {
    total.set(node, (total.get(node) ?? 0) + until - since.get(node)!);
    since.delete(node);
  };
  for (const run of runs) {
    const at = Date.parse(run.finishedAt);
    for (const node of [...since.keys()])
      if (!run.notReady.includes(node)) add(node, at);
    for (const node of run.notReady) if (!since.has(node)) since.set(node, at);
  }
  for (const node of [...since.keys()]) add(node, now.getTime());
  return total;
}

export function reliability(runs: SyncRun[], now: Date): Reliability {
  const succeeded = runs.filter((run) => run.ok).length;
  const counts = new Map<string, number>();
  for (const run of runs)
    for (const id of run.failing) counts.set(id, (counts.get(id) ?? 0) + 1);
  return {
    runs: runs.length,
    succeeded,
    successRate: runs.length ? succeeded / runs.length : null,
    meanDurationMs: runs.length
      ? Math.round(
          runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length
        )
      : null,
    failingChecks: [...counts]
      .map(([id, count]) => ({ id, runs: count }))
      .sort((a, b) => b.runs - a.runs || a.id.localeCompare(b.id))
      .slice(0, 10),
    notReady: [...notReadyTime(runs, now)]
      .map(([node, ms]) => ({ node, ms }))
      .sort((a, b) => b.ms - a.ms || a.node.localeCompare(b.node)),
  };
}

/** Read-only: the reliability of fleet-sync over a period, from the run
 * history kept in the fleet state.
 */
export function fleetReport(
  options: FleetReportOptions,
  env = process.env,
  now = new Date()
): CommandOutcome {
  const since = options.since ?? '30d';
  const from = now.getTime() - parseSince(since);
  const runs = readHistory(env).runs.filter(
    (run) => Date.parse(run.finishedAt) >= from
  );
  const summary = reliability(runs, now);
  const data = {
    version: 1,
    command: 'fleet-report',
    ok: true,
    since,
    ...summary,
    entries: runs,
  };
  return { exitCode: 0, data, text: render(since, summary) };
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

function render(since: string, summary: Reliability): string {
  if (!summary.runs) return `No fleet-sync run in the last ${since}.`;
  const lines = [
    `fleet-sync over the last ${since}: ${summary.runs} runs, ${summary.succeeded} succeeded (${Math.round((summary.successRate ?? 0) * 100)}%), ${Math.round((summary.meanDurationMs ?? 0) / 1000)} s on average.`,
  ];
  if (summary.failingChecks.length)
    lines.push(
      'Most frequent failing checks:',
      ...summary.failingChecks.map(
        (check) => `  ${check.id}  ${check.runs} runs`
      )
    );
  if (summary.notReady.length)
    lines.push(
      'Time not ready:',
      ...summary.notReady.map((node) => `  ${node.node}  ${minutes(node.ms)}`)
    );
  return lines.join('\n');
}
