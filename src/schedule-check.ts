import macos from '../ansible/macos/policy.json';
import type { ManagerDefinition } from './definition';
import type { History } from './state/history';
import type { Check } from './types';

/** How often the manager's schedule runs fleet-sync by default. */
export const SCHEDULE_INTERVAL_SECONDS = macos.fleetSync.intervalMinutes * 60;

/** How often the manager's scheduled jobs run: `manager.schedule` in
 * fleet.json, or the defaults of `ansible/macos/policy.json`.
 */
export function scheduleIntervals(
  manager: Pick<ManagerDefinition, 'schedule'>
): {
  syncSeconds: number;
  watchMinutes: number;
} {
  return {
    syncSeconds:
      (manager.schedule?.syncMinutes ?? macos.fleetSync.intervalMinutes) * 60,
    watchMinutes:
      manager.schedule?.watchMinutes ?? macos.fleetWatch.intervalMinutes,
  };
}

/** `manager:schedule`: a schedule that is on must have succeeded within two
 * of its intervals. A schedule that was never turned on is no check at all.
 */
export function scheduleCheck(history: History, now: Date): Check | null {
  const { schedule } = history;
  if (!schedule?.enabled) return null;
  const window = 2 * schedule.intervalSeconds * 1000;
  const lastSuccess = history.runs
    .filter((run) => run.trigger === 'schedule' && run.ok)
    .map((run) => Date.parse(run.finishedAt))
    .reduce((latest, at) => Math.max(latest, at), Number.NEGATIVE_INFINITY);
  // A schedule turned on a moment ago has had no chance to run yet.
  const since = Math.max(lastSuccess, Date.parse(schedule.changedAt));
  const minutes = Math.round(schedule.intervalSeconds / 60);
  if (now.getTime() - since <= window)
    return {
      id: 'manager:schedule',
      status: 'pass',
      summary: Number.isFinite(lastSuccess)
        ? `The schedule last converged the fleet at ${new Date(lastSuccess).toISOString()}.`
        : 'The schedule was turned on and has not had to run yet.',
    };
  return {
    id: 'manager:schedule',
    status: 'fail',
    summary: Number.isFinite(lastSuccess)
      ? `The schedule has not converged the fleet since ${new Date(lastSuccess).toISOString()}, more than two intervals of ${minutes} minutes.`
      : `The schedule has not converged the fleet once since it was turned on, more than two intervals of ${minutes} minutes ago.`,
    remedy: {
      action:
        'Run devfleet fleet-sync --schedule status on the manager to see the last scheduled runs, then devfleet fleet-report for the failing checks. Re-enable it with devfleet fleet-sync --schedule enable --apply --yes when the manager was replaced.',
    },
  };
}
