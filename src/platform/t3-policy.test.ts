import { expect, test } from 'bun:test';
import {
  loadedT3Policy,
  T3_RESTARTED_SUMMARY,
  verifyT3Policy,
} from './t3-policy';

test('policy observation tolerates startup without restarting or changing state', async () => {
  let calls = 0;
  let waits = 0;
  const result = await verifyT3Policy(
    '/pinned/t3',
    async (args, options) => {
      expect(args).toEqual(['/pinned/t3', 'policy', 'show']);
      expect(options?.timeoutMs).toBe(5000);
      calls++;
      return {
        ok: true,
        stdout: calls < 3 ? 'Not yet loaded.' : 'Server loaded this policy.',
        stderr: '',
        reason: 'exit',
      };
    },
    async () => {
      waits++;
    }
  );
  expect(result.status).toBe('pass');
  expect(waits).toBe(2);
});
test('policy observation stops at its bound and never promotes missing evidence', async () => {
  let calls = 0;
  const result = await verifyT3Policy(
    '/pinned/t3',
    async () => {
      calls++;
      return {
        ok: false,
        stdout: 'PRIVATE_SENTINEL',
        stderr: 'PRIVATE_SENTINEL',
        reason: 'timeout',
      };
    },
    async () => {}
  );
  expect(calls).toBe(6);
  expect(result.status).toBe('fail');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
});

test('staged policy is not reported active when native server still uses the previous policy', async () => {
  const check = await verifyT3Policy(
    '/managed/t3',
    async () => ({
      ok: true,
      stdout:
        'Server loaded the old policy. Restart T3 Code to apply the installed policy.',
      stderr: '',
      reason: 'exit',
    }),
    async () => {}
  );
  expect(check.status).toBe('fail');
  expect(check.summary).toBe('T3_POLICY_RESTART_PENDING');
});
test('native loaded-policy evidence is required', async () => {
  const check = await verifyT3Policy('/managed/t3', async () => ({
    ok: true,
    stdout: 'Server loaded this policy.\n',
    stderr: '',
    reason: 'exit',
  }));
  expect(check.status).toBe('pass');
});

const shows = (stdout: string) => async () => ({
  ok: true,
  stdout,
  stderr: '',
  reason: 'exit' as const,
});

test('the play restarts T3; this measures that the policy is loaded', async () => {
  const loaded = shows('The running server loaded this policy.');
  const restarted = await loadedT3Policy('/managed/t3', loaded, {
    restarted: true,
    pause: async () => {},
  });
  expect(restarted.status).toBe('pass');
  // The summary tells the manager to wait for the link to reconnect.
  expect(restarted.summary).toBe(T3_RESTARTED_SUMMARY);
  const untouched = await loadedT3Policy('/managed/t3', loaded, {
    restarted: false,
    pause: async () => {},
  });
  expect(untouched.status).toBe('pass');
  expect(untouched.summary).not.toBe(T3_RESTARTED_SUMMARY);
});

test('a policy still not loaded after the play is a failure, never a wait', async () => {
  const calls: string[][] = [];
  const check = await loadedT3Policy(
    '/managed/t3',
    async (args) => {
      calls.push(args);
      return {
        ok: true,
        stdout: 'Restart T3 Code to apply the installed policy.',
        stderr: '',
        reason: 'exit' as const,
      };
    },
    { restarted: true, pause: async () => {} }
  );
  expect(check.status).toBe('fail');
  expect(check.summary).toBe('T3_POLICY_RESTART_FAILED');
  expect(calls.every((args) => args[1] === 'policy')).toBe(true);
});
