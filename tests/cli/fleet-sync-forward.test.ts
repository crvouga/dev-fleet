import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const roots: string[] = [];
afterEach(async () => {
  delete process.env[NO_FORWARD_ENV];
  delete process.env['DEVFLEET_REPO'];
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
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
  expect(remote).not.toContain('devfleet');
  // Without a revision there is nothing to pin: use the installed launcher.
  expect(managerCommand(definition, {}, undefined, script).at(-1)).toMatch(
    /devfleet\W+fleet-sync/
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

const SCRIPT = '#!/bin/sh\necho run\n';
const repository = definition.source.repository;
const reply = (stdout: string | null) => ({
  ok: stdout !== null,
  reason: 'exit' as const,
  stdout: stdout ?? '',
  stderr: '',
});

/** A Git that holds `revision` in the directories listed, and nowhere else. */
function git(
  revision: string,
  holders: string[],
  log: string[][] = []
): Runner {
  const cloned = new Set<string>();
  return async (args, options) => {
    log.push([...args]);
    if (args[1] === 'clone') {
      cloned.add(args.at(-1)!);
      return reply('');
    }
    const cwd = options?.cwd ?? '';
    if (!holders.includes(cwd) && !cloned.has(cwd)) return reply(null);
    if (args[1] === 'remote') return reply(`${repository}\n`);
    if (args.includes('--show-toplevel')) return reply(`${cwd}\n`);
    if (args[1] === 'rev-parse') return reply(`${revision}\n`);
    return args[1] === 'show' ? reply(SCRIPT) : reply('');
  };
}

async function managerRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fleet-run-source-'));
  roots.push(root);
  // The run lock refuses a path through a symbolic link, as /tmp is on macOS.
  return realpath(root);
}

test('a manager sync re-runs itself from the fleet-owned checkout of its revision', async () => {
  const { runFromCheckout } = await import('../../src/cli/fleet-sync-checkout');
  const revision = 'b'.repeat(40);
  const commands: string[][] = [];
  const outcome = await runFromCheckout(
    { json: true },
    { revision, workspace: '/work', root: await managerRoot() },
    git(revision, ['/work']),
    async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: '{"version":3,"ok":true}' };
    }
  );
  expect(commands[0]).toEqual([
    'sh',
    '-c',
    SCRIPT,
    'fleet-manager-run',
    revision,
    '--json',
  ]);
  // A checkout that holds the revision supplies it; nothing is fetched.
  expect(process.env['DEVFLEET_REPO']).toBe('/work');
  expect(outcome).toEqual({ exitCode: 0, data: { version: 3, ok: true } });
});

test('run from the installed package, the revision comes from the source repository into a cache the manager owns', async () => {
  const { runFromCheckout } = await import('../../src/cli/fleet-sync-checkout');
  const revision = 'c'.repeat(40);
  const root = await managerRoot();
  const log: string[][] = [];
  const commands: string[][] = [];
  const outcome = await runFromCheckout(
    {},
    // Not a checkout: a directory under some project's node_modules.
    { revision, workspace: '/project/node_modules/dev-fleet', root },
    git(revision, [], log),
    async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: 'done' };
    }
  );
  const cache = join(root, 'source');
  expect(log.find((args) => args[1] === 'clone')).toEqual([
    'git',
    'clone',
    '--no-checkout',
    '--origin',
    'origin',
    repository,
    cache,
  ]);
  expect(process.env['DEVFLEET_REPO']).toBe(cache);
  expect(commands[0]!.slice(3)).toEqual(['fleet-manager-run', revision]);
  expect(outcome).toMatchObject({ exitCode: 0, text: 'done' });
});

test('a revision that cannot be fetched converges nothing, least of all in place', async () => {
  const { rehome, runFromCheckout } =
    await import('../../src/cli/fleet-sync-checkout');
  const source = {
    revision: 'd'.repeat(40),
    workspace: '/project/node_modules/dev-fleet',
    root: await managerRoot(),
  };
  const offline: Runner = async () => reply(null);
  const spawned = async () => {
    throw new Error('must not spawn');
  };
  expect(await runFromCheckout({}, source, offline, spawned)).toBeNull();
  const environment = process.env['NODE_ENV'];
  try {
    // Outside a test the run leaves this process or stops.
    process.env['NODE_ENV'] = 'production';
    expect(await rehome({}, source, offline)).toBe('unavailable');
  } finally {
    process.env['NODE_ENV'] = environment ?? 'test';
  }
  expect(await rehome({}, source, offline)).toBe('here');
});

test('a hand-off from the installed package sends the run script the package ships', async () => {
  const { managerRunScript } =
    await import('../../src/cli/fleet-sync-checkout');
  const revision = 'e'.repeat(40);
  const root = await managerRoot();
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(join(root, 'bootstrap/fleet-manager-run.sh'), SCRIPT);
  const absent: Runner = async () => reply(null);
  expect(
    await managerRunScript('/package', revision, absent, { revision, root })
  ).toBe(SCRIPT);
  // Another revision's script is never sent in its place.
  expect(
    await managerRunScript('/package', 'f'.repeat(40), absent, {
      revision,
      root,
    })
  ).toBeNull();
  // A checkout answers from Git, whatever the package holds.
  expect(
    await managerRunScript('/work', revision, git(revision, ['/work']), {
      revision: null,
      root,
    })
  ).toBe(SCRIPT);
});
