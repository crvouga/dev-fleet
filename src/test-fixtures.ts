import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, Runner, FleetNode } from './types';

export const HEAD = 'a'.repeat(40);
export const NODE: FleetNode = {
  id: 'dev-one',
  ssh: 'dev-one',
  workspace: '/home/dev/workspace',
  required: [],
};
export const success = (stdout = ''): CommandResult => ({
  ok: true,
  stdout,
  stderr: '',
  reason: 'exit',
});
export const failure = (stderr = ''): CommandResult => ({
  ok: false,
  stdout: '',
  stderr,
  reason: 'exit',
});
export const gitRunner: Runner = async (command) =>
  success(command.includes('rev-parse') ? HEAD : '');

export async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fleet test's "));
  for (const file of ['package.json', 'bun.lock', 'mise.toml', 'mise.lock'])
    await writeFile(join(root, file), '{}');
  await mkdir(join(root, 'packages/example'), { recursive: true });
  await writeFile(join(root, 'packages/example/package.json'), '{}');
  await mkdir(join(root, '.mise/locks'), { recursive: true });
  return root;
}
