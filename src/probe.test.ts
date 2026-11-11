import { afterEach, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { probe } from './probe';
import { CAPABILITIES } from './config';
import { authCheck } from './auth-checks';
import {
  compareFingerprints,
  dependencyCheck,
  fingerprint,
  writeReceipt,
} from './fingerprint';
import { failure, gitRunner, HEAD, success, workspace } from './test-fixtures';
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

test('compares manager reference revision and shared input hashes', async () => {
  const root = await fixture();
  const current = await fingerprint(root, gitRunner);
  expect(current.head).toBe(HEAD);
  expect(
    compareFingerprints(current, current).every(
      (check) => check.status === 'pass'
    )
  ).toBe(true);
  await writeFile(join(root, 'bun.lock'), 'changed');
  const changed = await fingerprint(root, gitRunner);
  expect(
    compareFingerprints(current, changed).find(
      (check) => check.id === 'sync:bun.lock'
    )?.status
  ).toBe('fail');
});

test('missing hashes never count as synchronized', () => {
  expect(
    compareFingerprints(
      { head: null, files: {} },
      { head: null, files: {} }
    ).every((check) => check.status === 'fail')
  ).toBe(true);
});

test('uncommitted workspace manifests and mise sidecars participate in sync fingerprints', async () => {
  const root = await fixture();
  const before = await fingerprint(root, gitRunner);
  await writeFile(
    join(root, 'packages/example/package.json'),
    '{"changed":true}'
  );
  await writeFile(join(root, '.mise/locks/extra.lock'), 'changed');
  const after = await fingerprint(root, gitRunner);
  expect(after.files['workspace-manifests']).not.toBe(
    before.files['workspace-manifests']
  );
  expect(after.files['mise-sidecars']).not.toBe(before.files['mise-sidecars']);
});

test('missing receipts are unverified; successful sync receipts become stale when inputs change', async () => {
  const root = await fixture();
  const current = await fingerprint(root, gitRunner);
  expect((await dependencyCheck(root, current)).status).toBe('warn');
  await writeReceipt(root, current);
  expect((await dependencyCheck(root, current)).status).toBe('pass');
  await writeFile(join(root, 'mise.lock'), 'changed');
  expect(
    (await dependencyCheck(root, await fingerprint(root, gitRunner))).status
  ).toBe('fail');
});

test('unrequested capabilities skip without contacting authentication services', async () => {
  const commands: string[][] = [];
  const snapshot = await probe(await fixture(), [], async (command) => {
    commands.push(command);
    return gitRunner(command);
  });
  expect(commands.every((command) => command[0] === 'git')).toBe(true);
  expect(
    snapshot.checks.filter((check) => check.status === 'skip').length
  ).toBe(CAPABILITIES.length);
});

test('authentication failures do not expose credentials, private errors or command output', async () => {
  const run: Runner = async () => ({
    ...failure('password=never-print-this'),
    stdout: 'token=never-print-this',
  });
  for (const capability of [
    'github',
    'vault',
    't3',
    'vscode',
    'toolchain',
  ] as const) {
    const checks = await authCheck(capability, run, '/repo');
    expect(checks.some((check) => check.status === 'fail')).toBe(true);
    expect(JSON.stringify(checks)).not.toContain('never-print-this');
  }
});

test('VS Code checks the local extension and does not equate arbitrary success with extension availability', async () => {
  expect(
    (
      await authCheck(
        'vscode',
        async () => success('ms-vscode-remote.remote-ssh\n'),
        '/repo'
      )
    )[0]?.status
  ).toBe('pass');
  expect(
    (
      await authCheck(
        'vscode',
        async () => success('unrelated.extension'),
        '/repo'
      )
    )[0]?.status
  ).toBe('fail');
});

test('T3 distinguishes enabled settings, local API and untested end-to-end connectivity', async () => {
  const run: Runner = async (command) =>
    success(
      command.includes('status')
        ? JSON.stringify({
            connect: { enabled: true, revoked: false },
            token: 'never-print-this',
          })
        : '[]'
    );
  const checks = await authCheck('t3', run, '/repo');
  expect(checks.map((check) => check.status)).toEqual(['pass', 'pass', 'skip']);
  expect(JSON.stringify(checks)).not.toContain('never-print-this');
  const revoked = await authCheck(
    't3',
    async () => success('{"connect":{"enabled":true,"revoked":true}}'),
    '/repo'
  );
  expect(revoked[0]?.status).toBe('fail');
});

test('T3 falls back to the pinned native CLI when no t3 launcher is on PATH', async () => {
  const pinned =
    '/home/dev/.local/share/personal/tools/t3-0.1.8-linux-arm64/t3';
  const used: string[] = [];
  const run: Runner = async (command) => {
    if (command[0] === 'sh') return success(`${pinned}\n`);
    used.push(command[0] ?? '');
    return command[1] === 'status'
      ? success(JSON.stringify({ connect: { enabled: true, revoked: false } }))
      : success('[]');
  };
  const checks = await authCheck('t3', run, '/repo');
  expect(used).toEqual([pinned, pinned]);
  expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
});
