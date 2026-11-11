import { test, expect } from 'bun:test';
import {
  configureWorkspace,
  decodeReceipt,
  validConfiguration,
} from './configure';
import type { Runner } from './types';

const revision = 'a'.repeat(40);
const request = { revision, node: 'canary', tool: 'codex', profile: 'proxy' };

test('configuration requires exact commit and safe selectors', () => {
  expect(validConfiguration(request)).toBe(true);
  expect(validConfiguration({ ...request, revision: 'main' })).toBe(false);
  expect(validConfiguration({ ...request, node: '../escape' })).toBe(false);
  expect(
    decodeReceipt(
      JSON.stringify({ ok: true, revision, fingerprint: 'b'.repeat(64) }),
      revision
    )
  ).toBe('b'.repeat(64));
  expect(
    decodeReceipt(
      JSON.stringify({
        ok: true,
        revision: 'c'.repeat(40),
        fingerprint: 'b'.repeat(64),
      }),
      revision
    )
  ).toBeNull();
  expect(decodeReceipt('secret response', revision)).toBeNull();
});

test('unavailable revision fails without mutation or subprocess output leakage', async () => {
  const calls: string[][] = [];
  const run: Runner = async (command) => {
    calls.push(command);
    return {
      ok: false,
      stdout: 'PRIVATE_SENTINEL',
      stderr: 'PRIVATE_SENTINEL',
      reason: 'exit',
    };
  };
  const checks = await configureWorkspace('/unused', request, run);
  expect(checks[0]?.status).toBe('fail');
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(checks)).not.toContain('PRIVATE_SENTINEL');
});

test('setup failure preserves previous successful rollout receipt', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'fleet-config-'));
  try {
    const dir = join(root, 'node_modules', '.fleet-configuration');
    await mkdir(dir, { recursive: true });
    const receipt = join(dir, 'canary-codex-proxy.json');
    await writeFile(receipt, 'previous-success');
    const run: Runner = async (command, options) => {
      const stdout = command.includes('--show-toplevel')
        ? options!.cwd!
        : command.includes('--porcelain')
          ? ''
          : revision;
      return {
        ok: command[0] !== 'mise',
        stdout,
        stderr: 'PRIVATE_SENTINEL',
        reason: 'exit',
      };
    };
    const result = await configureWorkspace(root, request, run);
    expect(result[0]?.status).toBe('fail');
    expect(await readFile(receipt, 'utf8')).toBe('previous-success');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an already bootstrapped managed revision is verified without a second setup or worktree', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'fleet-prepared-'));
  const calls: string[][] = [];
  try {
    const run: Runner = async (command) => {
      calls.push(command);
      let stdout = revision;
      if (command.includes('--porcelain')) stdout = '';
      if (command.includes('--show-toplevel')) stdout = root;
      if (command.includes('agents'))
        stdout = JSON.stringify({
          ok: true,
          revision,
          fingerprint: 'b'.repeat(64),
        });
      return { ok: true, stdout, stderr: '', reason: 'exit' };
    };
    const result = await configureWorkspace(root, request, run, {
      additionalTools: ['opencode'],
      bootstrappedDeployment: true,
    });
    expect(result.every((check) => check.status === 'pass')).toBe(true);
    expect(
      calls.some(
        (command) =>
          command.includes('bootstrap/setup.ts') || command.includes('worktree')
      )
    ).toBe(false);
    expect(calls.filter((command) => command.includes('agents'))).toHaveLength(
      2
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('prepared mode does not trust a marker or skip actual checkout drift inspection', async () => {
  const calls: string[][] = [];
  const result = await configureWorkspace(
    '/managed',
    request,
    async (command) => {
      calls.push(command);
      return {
        ok: true,
        stdout: command.includes('--porcelain') ? ' M tracked-file' : revision,
        stderr: '',
        reason: 'exit',
      };
    },
    { additionalTools: [], bootstrappedDeployment: true }
  );
  expect(result[0]?.status).toBe('fail');
  expect(calls.some((command) => command.includes('agents'))).toBe(false);
});
