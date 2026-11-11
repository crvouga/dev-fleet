import { afterEach, expect, test } from 'bun:test';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncPlan, syncWorkspace } from './sync';
import { fingerprint, writeReceipt } from './fingerprint';
import { failure, gitRunner, success, workspace } from './test-fixtures';
import type { Runner } from './types';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await workspace();
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test('sync plans do not execute anything and document ownership boundaries', () => {
  expect(syncPlan(false).join(' ')).not.toContain('git pull');
  expect(syncPlan(true).join(' ')).toContain('git pull --ff-only');
  expect(syncPlan(false).join(' ')).toContain('bootstrap/setup.ts');
});

test('dirty or detached checkouts refuse pulling before mutation', async () => {
  for (const detached of [false, true]) {
    const commands: string[][] = [];
    const run: Runner = async (command) => {
      commands.push(command);
      if (command.includes('status'))
        return success(detached ? '' : ' M private-file');
      if (command.includes('symbolic-ref')) return failure();
      return gitRunner(command);
    };
    const checks = await syncWorkspace(await fixture(), true, run);
    expect(checks[0]?.status).toBe('fail');
    expect(
      commands.some(
        (command) => command.includes('pull') || command[0] === 'mise'
      )
    ).toBe(false);
  }
});

test('failed setup invalidates receipts and never records successful sync', async () => {
  const root = await fixture();
  await writeReceipt(root, await fingerprint(root, gitRunner));
  const checks = await syncWorkspace(root, false, async (command) =>
    command[0] === 'mise' ? failure('secret-token') : gitRunner(command)
  );
  expect(checks[0]?.status).toBe('fail');
  expect(JSON.stringify(checks)).not.toContain('secret-token');
  expect(
    await Bun.file(join(root, 'node_modules/.fleet-sync.json')).exists()
  ).toBe(false);
});

test('successful setup uses shared frozen toolchain path and records a receipt', async () => {
  const root = await fixture();
  const commands: string[][] = [];
  const checks = await syncWorkspace(root, false, async (command) => {
    commands.push(command);
    return gitRunner(command);
  });
  expect(checks[0]?.status).toBe('pass');
  expect(commands.find((command) => command[0] === 'mise')).toEqual([
    'mise',
    'exec',
    '--locked',
    'bun',
    '--',
    'bun',
    'bootstrap/setup.ts',
    '--non-interactive',
  ]);
  expect(
    JSON.parse(
      await readFile(join(root, 'node_modules/.fleet-sync.json'), 'utf8')
    ).version
  ).toBe(1);
});

test('failed fast-forward stops before tool installation', async () => {
  const commands: string[][] = [];
  const checks = await syncWorkspace(await fixture(), true, async (command) => {
    commands.push(command);
    return command.includes('pull') ? failure() : gitRunner(command);
  });
  expect(checks[0]?.status).toBe('fail');
  expect(commands.some((command) => command[0] === 'mise')).toBe(false);
});
