import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import macos from '../../ansible/macos/policy.json';
import type { Runner, CommandOptions, CommandResult } from '../types';

/** Ubuntu provides ansible-core through APT; macOS runs the pinned release through
 * uv's isolated tool runner so no global Python environment is modified.
 */
export function ansibleCommand(
  path = process.env['PATH'] ?? '',
  exists: (candidate: string) => boolean = existsSync
): string[] {
  const found = path
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => exists(join(directory, 'ansible-playbook')));
  return found
    ? ['ansible-playbook']
    : [
        'uvx',
        '--from',
        `ansible-core==${macos.ansibleCore}`,
        'ansible-playbook',
      ];
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
  options: CommandOptions & { input: string },
  scratch = variablesDirectory()
): Promise<CommandResult> {
  if (Buffer.byteLength(options.input) > 256 * 1024)
    throw new Error('ANSIBLE_VARIABLE_LIMIT');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(scratch, 'personal-ansible-'));
  const path = join(directory, 'variables.json');
  try {
    await writeFile(path, options.input, { mode: 0o600, flag: 'wx' });
    const { input: _input, ...commandOptions } = options;
    return await run(
      [...ansibleCommand(), playbook, '--extra-vars', '@' + path],
      commandOptions
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
