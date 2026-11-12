import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PACKAGE_ROOT } from '../package-info';
import type { Runner, CommandOptions, CommandResult } from '../types';

/** The Ansible each machine runs playbooks with, pinned either way. A worker
 * has the exact `ansible-core` package the Ubuntu policy names. The manager
 * runs the project in `ansible/` (`pyproject.toml`, `uv.lock`): one release on
 * one Python, every dependency checked against its locked hash, in a
 * throwaway environment. No global Python environment is modified, nothing is
 * written into the checkout, and an `ansible-playbook` that happens to be on
 * PATH is never used.
 */
export function ansibleCommand(
  platform: NodeJS.Platform = process.platform,
  root = PACKAGE_ROOT
): string[] {
  return platform === 'linux'
    ? ['ansible-playbook']
    : [
        'uv',
        'run',
        '--project',
        join(root, 'ansible'),
        '--locked',
        '--isolated',
        '--quiet',
        'ansible-playbook',
      ];
}

/** The package's Ansible configuration (ansible/ansible.cfg): how Ansible
 * reaches a worker over SSH (timeouts, retries, pipelining, connection
 * reuse) beside the options src/ssh-connection.ts gives every session.
 */
export function ansibleConfig(root = PACKAGE_ROOT): NodeJS.ProcessEnv {
  return { ANSIBLE_CONFIG: join(root, 'ansible', 'ansible.cfg') };
}

/** Private fleet state on disk, never /tmp: a worker's /tmp is RAM-backed with a
 * per-user quota that agent caches can exhaust, and the baseline that bounds it
 * must still be able to run then.
 */
export function variablesDirectory(home = homedir()): string {
  return join(home, '.local/state/personal/fleet/run');
}

/** Ansible resolves @file paths before opening them; @/dev/stdin is not portable
 * across versions when stdin is a pipe. Keep runtime variables in a private,
 * short-lived directory instead. Never put their values in argv or logs.
 */
export async function runAnsible(
  run: Runner,
  playbook: string,
  options: CommandOptions & {
    input: string;
    /** Run in check mode: report what would change, change nothing. */
    check?: boolean;
  },
  scratch = variablesDirectory()
): Promise<CommandResult> {
  if (Buffer.byteLength(options.input) > 256 * 1024)
    throw new Error('ANSIBLE_VARIABLE_LIMIT');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(scratch, 'personal-ansible-'));
  const path = join(directory, 'variables.json');
  try {
    await writeFile(path, options.input, { mode: 0o600, flag: 'wx' });
    const { input: _input, check, ...commandOptions } = options;
    return await run(
      [
        ...ansibleCommand(),
        playbook,
        ...(check ? ['--check'] : []),
        '--extra-vars',
        '@' + path,
      ],
      { ...commandOptions, env: { ...ansibleConfig(), ...commandOptions.env } }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A playbook of the package, applied from the manager with these variables:
 * one that addresses a worker over SSH itself (ansible/ubuntu/reboot.yml).
 * Scenarios answer it in place of Ansible.
 */
export type PackagePlaybook = (
  name: string,
  variables: object,
  timeoutMs: number
) => Promise<CommandResult>;

export function packagePlaybook(run: Runner): PackagePlaybook {
  return (name, variables, timeoutMs) =>
    runAnsible(run, join(PACKAGE_ROOT, 'ansible', name), {
      input: JSON.stringify(variables),
      timeoutMs,
    });
}
