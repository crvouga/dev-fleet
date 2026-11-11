import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Check } from '../types';
import { VERIFY_MAX_AGE_MS, cachedCheck } from './verify-cache';

let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'verify-cache-'));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const pass: Check = {
  id: 'provider:x:inference',
  status: 'pass',
  summary: 'ok',
};
const fail: Check = {
  id: 'provider:x:inference',
  status: 'fail',
  summary: 'BAD',
};

function counting(result: Check) {
  let calls = 0;
  return {
    compute: async () => {
      calls++;
      return result;
    },
    calls: () => calls,
  };
}

test('a pass is reused while its key is unchanged and fresh', async () => {
  const probe = counting(pass);
  await cachedCheck('x', 'k1', probe.compute, { directory, now: 0 });
  const reused = await cachedCheck('x', 'k1', probe.compute, {
    directory,
    now: 60_000,
  });
  expect(probe.calls()).toBe(1);
  expect(reused.status).toBe('pass');
  expect(reused.summary).toContain('verified 1m ago');
});

test('a changed key, age, bypass or failure verifies again', async () => {
  const probe = counting(pass);
  await cachedCheck('x', 'k1', probe.compute, { directory, now: 0 });
  await cachedCheck('x', 'k2', probe.compute, { directory, now: 1 });
  await cachedCheck('x', 'k2', probe.compute, {
    directory,
    now: VERIFY_MAX_AGE_MS + 1,
  });
  await cachedCheck('x', 'k2', probe.compute, {
    directory,
    now: VERIFY_MAX_AGE_MS + 2,
    bypass: true,
  });
  expect(probe.calls()).toBe(4);
  const failing = counting(fail);
  await cachedCheck('y', 'k', failing.compute, { directory, now: 0 });
  await cachedCheck('y', 'k', failing.compute, { directory, now: 1 });
  expect(failing.calls()).toBe(2);
});

test('a pass the caller marks not reusable (quota) is never cached', async () => {
  const probe = counting(pass);
  const options = { directory, now: 0, reuse: () => false };
  await cachedCheck('q', 'k', probe.compute, options);
  await cachedCheck('q', 'k', probe.compute, options);
  expect(probe.calls()).toBe(2);
});
