import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { applyAgent, refusal } from './apply';
import type { Runner } from '../types';

const root = resolve(import.meta.dir, '../..');
const revision = 'a'.repeat(40);
for (const conflict of [
  'revision',
  'nested-checkout',
  'dirty',
  'status-failed',
]) {
  test(`monitoring refuses ${conflict} before installation`, async () => {
    const calls: string[][] = [];
    const run: Runner = async (args) => {
      calls.push([...args]);
      const status = args.includes('--porcelain');
      return {
        ok: !(status && conflict === 'status-failed'),
        reason: 'exit',
        stdout: status
          ? conflict === 'dirty'
            ? ' M ansible/monitoring/agent.yml'
            : ''
          : args.includes('--show-toplevel')
            ? conflict === 'nested-checkout'
              ? '/another-checkout'
              : root
            : conflict === 'revision'
              ? 'b'.repeat(40)
              : revision,
        stderr: '',
      };
    };
    await expect(
      applyAgent(
        {
          node: 'worker-one',
          revision,
          mode: 'hub',
          hubUrl: 'https://hub.example.ts.net:8443',
        },
        root,
        run
      )
    ).rejects.toThrow('BESZEL_SOURCE_MISMATCH');
    expect(calls.every((args) => args[0] === 'git')).toBe(true);
  });
}

const clean: Runner = async (args) => ({
  ok: true,
  reason: 'exit',
  stderr: '',
  stdout: args.includes('--porcelain')
    ? ''
    : args.includes('--show-toplevel')
      ? root
      : revision,
});
test('hub mode is refused on every worker: the hub runs only on the manager', async () => {
  const error = await applyAgent(
    {
      node: 'worker-one',
      revision,
      mode: 'hub',
      hubUrl: 'https://manager-mac-1.tail0a1b2c.ts.net:8443',
    },
    root,
    clean
  ).catch((caught: unknown) => caught);
  expect((error as Error).message).toBe('BESZEL_NOT_HUB');
  const [check] = refusal(error);
  expect(check?.summary).toBe('BESZEL_NOT_HUB');
  expect(check?.remedy?.action).toContain('runs only on the manager');
});
test('agents accept only the manager hub URL and undeclared machines are refused', async () => {
  const agent = {
    revision,
    publicKey: 'ssh-ed25519 fixture',
    token: 'disposable-fixture-token',
  };
  await expect(
    applyAgent(
      {
        ...agent,
        node: 'worker-one',
        hubUrl: 'https://worker-one.tail0a1b2c.ts.net:8443',
      },
      root,
      clean
    )
  ).rejects.toThrow('BESZEL_HUB_MISMATCH');
  await expect(
    applyAgent(
      {
        ...agent,
        node: 'unknown-node',
        hubUrl: 'https://manager-mac-1.tail0a1b2c.ts.net:8443',
      },
      root,
      clean
    )
  ).rejects.toThrow('BESZEL_NOT_ENROLLED');
  expect(refusal(new Error('raw secret detail'))[0]?.summary).toBe(
    'BESZEL_OPERATION_INCOMPLETE'
  );
});
