import { expect, test } from 'bun:test';
import { authorizePrivilege } from '../../src/cli/fleet-sync-privilege';
import type { FleetNode } from '../../src/types';
const node: FleetNode = {
  id: 'fixture',
  ssh: 'fixture',
  workspace: '/unused',
  required: [],
};
test('existing sudo authorization does not prompt or change policy', async () => {
  let calls = 0;
  const checks = await authorizePrivilege(node, undefined, async (args) => {
    calls++;
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args.at(-1)).toBe('sudo -n true');
    return { ok: true, stdout: '', stderr: '', reason: 'exit' };
  });
  expect(checks).toEqual([]);
  expect(calls).toBe(1);
});
test('unknown SSH trust stays an SSH failure without prompting for sudo', async () => {
  const checks = await authorizePrivilege(node, '#!/bin/sh', async () => ({
    ok: false,
    stdout: '',
    stderr: 'Host key verification failed. PRIVATE_SENTINEL',
    reason: 'exit',
  }));
  expect(checks[0]?.id).toBe('ssh:host-key');
  expect(JSON.stringify(checks)).not.toContain('PRIVATE_SENTINEL');
});
test('missing privilege without an authorization payload remains action required', async () => {
  const checks = await authorizePrivilege(node, undefined, async () => ({
    ok: false,
    stdout: '',
    stderr: 'sudo: a password is required',
    reason: 'exit',
  }));
  expect(checks[0]?.summary).toBe('SUDO_AUTHORIZATION_REQUIRED');
});
