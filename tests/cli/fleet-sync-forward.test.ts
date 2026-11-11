import { afterEach, expect, test } from 'bun:test';
import canonical from '../../examples/fleet.json';
import { parseDefinition } from '../../src/definition';
import type { Runner } from '../../src/types';
import { fleetSync } from '../../src/cli/fleet-sync';
import {
  forwardedFlags,
  forwardToManager,
  managerCommand,
  NO_FORWARD_ENV,
} from '../../src/cli/fleet-sync-forward';

const definition = parseDefinition(canonical);
const revision = 'a'.repeat(40);
const settings = { workspace: '/no-checkout', config: '/no-roster' };
/** A worker: no scutil, no checkout. */
const worker: Runner = async () => ({
  ok: false,
  reason: 'missing',
  stdout: '',
  stderr: '',
});
afterEach(() => {
  delete process.env[NO_FORWARD_ENV];
});

test('the hand-off targets the manager over verified SSH and never hands off again', () => {
  const command = managerCommand(definition, { json: true }, revision);
  const { user, tailscaleName } = definition.manager.network;
  expect(command).toContain(`${user}@${tailscaleName}`);
  expect(command).toContain('StrictHostKeyChecking=yes');
  expect(command).toContain('-a');
  const script = command.at(-1)!;
  expect(script).toContain(`${NO_FORWARD_ENV}=1`);
  expect(script).toContain('fleet-sync');
  expect(script).toContain(revision);
});

test('with the tracked run script the manager runs the exact revision', () => {
  const script = '#!/bin/sh\necho run\n';
  const command = managerCommand(
    definition,
    { node: ['w1'], json: true },
    revision,
    script
  );
  const remote = command.at(-1)!;
  expect(remote).toContain('fleet-manager-run');
  expect(remote).toContain(revision);
  expect(remote).toContain('--json');
  expect(remote).not.toContain("'personal' 'fleet-sync'");
  // Without a revision there is nothing to pin: use the installed launcher.
  expect(managerCommand(definition, {}, undefined, script).at(-1)).toContain(
    'fleet-sync'
  );
  expect(
    managerCommand(definition, {}, undefined, script).at(-1)
  ).not.toContain('fleet-manager-run');
});

test('forwarded flags preserve the request', () => {
  expect(
    forwardedFlags(
      { node: ['w1', 'w2'], dryRun: true, json: true, schedule: 'status' },
      revision
    )
  ).toEqual([
    '--revision',
    revision,
    '--node',
    'w1',
    '--node',
    'w2',
    '--schedule',
    'status',
    '--dry-run',
    '--json',
  ]);
});

test('a worker hands fleet-sync to the manager and reports its result', async () => {
  const commands: string[][] = [];
  const result = await fleetSync(
    { revision, json: true },
    settings,
    worker,
    async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }) };
    }
  );
  expect(commands).toHaveLength(1);
  expect(result).toEqual({ exitCode: 0, data: { ok: true } });
});

test('an unreachable manager is reported, not a partial worker run', async () => {
  const result = await forwardToManager(definition, {}, revision, {
    spawn: async () => ({ exitCode: 255, stdout: '' }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({ code: 'FLEET_MANAGER_UNREACHABLE' });
});

test('tests can never reach the real manager', async () => {
  await expect(forwardToManager(definition, {}, revision)).rejects.toThrow(
    'FLEET_FORWARD_IN_TEST'
  );
});

test('off the manager with hand-off disabled, nothing runs', async () => {
  process.env[NO_FORWARD_ENV] = '1';
  const calls: string[][] = [];
  const result = await fleetSync(
    { revision, json: true },
    settings,
    async (args, options) => {
      calls.push([...args]);
      return worker(args, options);
    },
    async () => {
      throw new Error('must not forward');
    }
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.stringify(result.data)).toContain('FLEET_NOT_MANAGER');
  expect(calls.every((args) => args[0] === 'scutil')).toBe(true);
});

test('a manager sync re-runs itself from the fleet-owned checkout of its revision', async () => {
  const { runFromCheckout } = await import('../../src/cli/fleet-sync-checkout');
  const revision = 'b'.repeat(40);
  const commands: string[][] = [];
  const outcome = await runFromCheckout(
    { json: true },
    { revision, workspace: '/work' },
    async (args) => ({
      ok: args[1] === 'show',
      reason: 'exit',
      stdout: '#!/bin/sh\necho run\n',
      stderr: '',
    }),
    async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: '{"version":3,"ok":true}' };
    }
  );
  expect(commands[0]).toEqual([
    'sh',
    '-c',
    '#!/bin/sh\necho run\n',
    'fleet-manager-run',
    revision,
    '--json',
  ]);
  expect(outcome).toEqual({ exitCode: 0, data: { version: 3, ok: true } });
});

test('a revision without the run script converges in place', async () => {
  const { runFromCheckout } = await import('../../src/cli/fleet-sync-checkout');
  const outcome = await runFromCheckout(
    {},
    { revision: 'c'.repeat(40), workspace: '/work' },
    async () => ({ ok: false, reason: 'exit', stdout: '', stderr: '' }),
    async () => {
      throw new Error('must not spawn');
    }
  );
  expect(outcome).toBeNull();
});
