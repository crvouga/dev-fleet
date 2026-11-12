import type { PackagePlaybook } from './platform/ansible';
import { playbookConnection } from './ssh';
import type { Check } from './types';

/** The codes ansible/ubuntu/worker-account.yml stops with. */
const CODES = [
  'WORKER_ACCOUNT_UNDECLARED',
  'WORKER_ACCOUNT_ROOT_REQUIRED',
  'SUDOERS_OWNERSHIP_CONFLICT',
];

/** The one command that creates the account by hand, for the remedy. */
export function accountCommand(user: string): string {
  return `useradd --create-home --shell /bin/bash --groups sudo ${user}`;
}

/** Creates the declared worker account over a root login, through
 * ansible/ubuntu/worker-account.yml run from the manager: an image that lets
 * only root in gets the account the fleet converges, with the key root was
 * reached with and the fleet's sudo rule. `login` is `root` when the alias
 * names another user that cannot log in yet, and empty when the alias logs
 * in as root itself.
 */
export async function createWorkerAccount(
  target: { id: string; ssh: string; login: 'root' | '' },
  user: string | undefined,
  playbook: PackagePlaybook
): Promise<Check> {
  const failure = (summary: string, action: string): Check => ({
    id: 'worker:account',
    status: 'fail',
    summary,
    remedy: { action },
  });
  if (!user || user === 'root')
    return failure(
      'WORKER_ACCOUNT_UNDECLARED',
      'The worker lets only root in, and fleet.json names no non-root account for it. Declare workers[].network.user; fleet-sync then creates that account and continues as it.'
    );
  const result = await playbook(
    'ubuntu/worker-account.yml',
    {
      target: target.ssh,
      login: target.login,
      user,
      ssh_options: playbookConnection(target).options,
    },
    300_000
  );
  if (result.ok)
    return {
      id: 'worker:account',
      status: 'pass',
      summary: `Created the declared account ${user} over the root login, with the key root was reached with and the fleet's sudo rule.`,
    };
  const code =
    CODES.find((candidate) => result.stdout.includes(candidate)) ??
    'WORKER_ACCOUNT_CREATION_FAILED';
  return failure(
    code,
    `The declared account ${user} could not be created over the root login. Create it on the worker as root (${accountCommand(user)}), authorise the manager's key for it and grant it passwordless sudo, then rerun fleet-sync.`
  );
}
