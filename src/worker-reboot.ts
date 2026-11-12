import { playbookConnection } from './ssh';
import type { PackagePlaybook } from './platform/ansible';
import { blocking, type Check, type FleetNode } from './types';

/** Why fleet-sync reboots a worker: its first converge, which nothing can be
 * running on yet, or a maintenance reboot the operator asked for
 * (`--maintenance-reboot`) to apply installed updates.
 */
export type RebootReason = 'first-converge' | 'maintenance';

/** The boot-policy codes a reboot settles: the managed power files were
 * written after this boot, or the running login manager has not loaded them.
 */
const SETTLED_BY_REBOOT = [
  'UBUNTU_MAINTENANCE_REBOOT_PENDING',
  'UBUNTU_SESSION_POLICY_PENDING',
];

/** The converge ran (its bootstrap passed) and says a reboot is needed. */
export function rebootNeeded(checks: Check[]): boolean {
  if (
    checks.some((check) => check.id.startsWith('bootstrap:') && blocking(check))
  )
    return false;
  return checks.some(
    (check) =>
      (check.id === 'ubuntu:boot-policy' &&
        SETTLED_BY_REBOOT.includes(check.summary)) ||
      (check.id === 'worker:reboot-pending' && check.status !== 'pass')
  );
}

/** A maintenance run goes on to the next worker only once this one is back
 * and ready: a reboot that failed, or one after which the worker is not
 * ready, stops the rest.
 */
export function rebootStopsRollout(node: { checks: Check[] }): boolean {
  const reboot = node.checks.find((check) => check.id === 'worker:reboot');
  if (!reboot) return false;
  if (reboot.summary === 'WORKER_REBOOT_FAILED') return true;
  return reboot.status === 'pass' && node.checks.some(blocking);
}

/** Installed updates wait for a reboot: what --maintenance-reboot applies. */
export function updatesPending(checks: Check[]): boolean {
  return checks.some(
    (check) => check.id === 'worker:reboot-pending' && check.status !== 'pass'
  );
}

/** The home of the account a roster entry converges, from its workspace. */
export function workerHome(node: FleetNode): string | null {
  const suffix = '/.local/share/personal/fleet';
  return node.workspace.endsWith(suffix)
    ? node.workspace.slice(0, -suffix.length) || null
    : null;
}

/** Reboots one worker through ansible/ubuntu/reboot.yml, run from the
 * manager: only while its T3 runs no agent turn (unless `force`), waiting
 * until it answers again. The play's output is read for its own codes only.
 */
export async function rebootWorker(
  node: FleetNode,
  request: { revision: string; reason: RebootReason; force?: boolean },
  playbook: PackagePlaybook
): Promise<Check> {
  const home = workerHome(node);
  if (!home)
    return {
      id: 'worker:reboot',
      status: 'fail',
      summary: 'WORKER_REBOOT_FAILED',
      remedy: {
        action:
          'The roster names no workspace under the account home, so the worker was not rebooted. Rerun fleet-sync once it is enrolled.',
      },
    };
  // `user@alias` only for a worker whose account this run created.
  // A worker reached from declared data logs in as its declared account.
  const connection = playbookConnection(node);
  const [login, target] = node.ssh.includes('@')
    ? node.ssh.split('@', 2)
    : [connection.user ?? '', node.ssh];
  const result = await playbook(
    'ubuntu/reboot.yml',
    {
      target,
      login,
      home,
      revision: request.revision,
      reason: request.reason,
      force: Boolean(request.force),
      ssh_options: connection.options,
    },
    // The play waits up to 900 seconds for the worker to answer again.
    1_200_000
  );
  if (result.ok)
    return {
      id: 'worker:reboot',
      status: 'pass',
      summary:
        request.reason === 'first-converge'
          ? 'Rebooted once after its first converge, which no agent turn ran on; it answered again and was converged once more.'
          : 'Rebooted for maintenance while no agent turn ran; it answered again and was converged once more.',
    };
  if (result.stdout.includes('WORKER_REBOOT_BUSY'))
    return {
      id: 'worker:reboot',
      // A busy worker is left alone, and the others still go: its boot
      // policy or its pending updates still say a reboot is needed.
      status: 'warn',
      summary: 'WORKER_REBOOT_BUSY',
      remedy: {
        action:
          'An agent turn is running on the worker, so it was not rebooted. Rerun fleet-sync --maintenance-reboot once the turn has ended, or add --force to end it.',
      },
    };
  return {
    id: 'worker:reboot',
    status: 'fail',
    summary: 'WORKER_REBOOT_FAILED',
    remedy: {
      action:
        'The reboot did not complete, or the worker did not answer within 15 minutes. Check its console with the provider, then rerun fleet-sync.',
    },
  };
}
