import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECEIPT_MAX_AGE_MS, runAnsibleWithReceipt } from './ansible-receipt';
import type { Runner } from '../types';

let root = '';
let sources = '';
let directory = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ansible-receipt-'));
  sources = join(root, 'playbooks');
  directory = join(root, 'receipts');
  await mkdir(join(sources, 'tasks'), { recursive: true });
  await writeFile(join(sources, 'site.yml'), 'v1');
  await writeFile(join(sources, 'tasks', 'a.yml'), 'a');
});
afterEach(() => rm(root, { recursive: true, force: true }));

function ansible(ok = true) {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push([...args]);
    return { ok, reason: 'exit', stdout: '', stderr: '' };
  };
  return { run, calls };
}
const apply = (
  run: Runner,
  extra: {
    verify?: boolean;
    input?: string;
    now?: number;
    force?: boolean;
  } = {}
) =>
  runAnsibleWithReceipt(
    run,
    'site.yml',
    { input: extra.input ?? '{"a":1}' },
    {
      name: 'site',
      sources: [sources],
      directory,
      verify: async () => extra.verify ?? true,
      ...(extra.now === undefined ? {} : { now: extra.now }),
      ...(extra.force ? { force: true } : {}),
    }
  );

test('an unchanged, verified apply is skipped on the next run', async () => {
  const { run, calls } = ansible();
  expect((await apply(run)).cached).toBe(false);
  expect((await apply(run)).cached).toBe(true);
  expect(calls).toHaveLength(1);
  const receipt = await readFile(join(directory, 'site.json'), 'utf8');
  expect(receipt).not.toContain('"a":1');
});

test('changed sources, changed variables, a failed probe, force and age all re-apply', async () => {
  const { run, calls } = ansible();
  await apply(run);
  await writeFile(join(sources, 'tasks', 'a.yml'), 'b');
  expect((await apply(run)).cached).toBe(false);
  expect((await apply(run, { input: '{"a":2}' })).cached).toBe(false);
  expect((await apply(run, { input: '{"a":2}', verify: false })).cached).toBe(
    false
  );
  expect((await apply(run, { input: '{"a":2}', force: true })).cached).toBe(
    false
  );
  expect(
    (
      await apply(run, {
        input: '{"a":2}',
        now: Date.now() + RECEIPT_MAX_AGE_MS,
      })
    ).cached
  ).toBe(false);
  expect(calls).toHaveLength(6);
});

test('a failed apply clears the receipt so the next run applies in full', async () => {
  await apply(ansible().run);
  const failing = ansible(false);
  await writeFile(join(sources, 'site.yml'), 'v2');
  expect((await apply(failing.run)).ok).toBe(false);
  await writeFile(join(sources, 'site.yml'), 'v1');
  const again = ansible();
  expect((await apply(again.run)).cached).toBe(false);
  expect(again.calls).toHaveLength(1);
});

test('an unreadable source never skips', async () => {
  const { run, calls } = ansible();
  const missing = () =>
    runAnsibleWithReceipt(
      run,
      'site.yml',
      { input: '{}' },
      {
        name: 'missing',
        sources: [join(root, 'absent')],
        directory,
        verify: async () => true,
      }
    );
  await missing();
  expect((await missing()).cached).toBe(false);
  expect(calls).toHaveLength(2);
});
