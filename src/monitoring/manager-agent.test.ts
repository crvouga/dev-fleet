import { expect, test } from 'bun:test';
import { installManagerAgent } from './manager-agent';
import type { Runner } from '../types';

const enrollment = {
  systemId: 'abcdefghijklmno',
  hubUrl: 'https://hub.example.ts.net:8443',
  publicKey: 'ssh-ed25519 fixture',
  token: 'fixture-token-0123456789',
};

test('the manager agent is a per-user launch agent: no sudo, no secrets in argv', async () => {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push([...args]);
    return { ok: true, reason: 'exit', stderr: '', stdout: 'state = running' };
  };
  const checks = await installManagerAgent(
    '/repo',
    { node: 'manager', enrollment },
    run,
    { uid: 501, directory: '/dev/null/receipts' }
  );
  expect(calls[0]).toContain('agent-darwin.yml');
  expect(calls.flat()).not.toContain('sudo');
  expect(calls.flat().join(' ')).not.toContain(enrollment.token);
  expect(calls[1]).toEqual([
    '/bin/launchctl',
    'print',
    'gui/501/dev.devfleet.beszel-agent',
  ]);
  expect(checks[0]).toMatchObject({ id: 'beszel:service', status: 'pass' });
});

test('a stopped manager agent fails', async () => {
  const run: Runner = async (args) => ({
    ok: true,
    reason: 'exit',
    stderr: '',
    stdout: args[0] === '/bin/launchctl' ? 'state = waiting' : '',
  });
  const checks = await installManagerAgent(
    '/repo',
    { node: 'manager', enrollment },
    run,
    { uid: 501, directory: '/dev/null/receipts' }
  );
  expect(checks[0]?.summary).toBe('BESZEL_SERVICE_STOPPED');
});
