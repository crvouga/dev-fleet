import { afterEach, expect, test } from 'bun:test';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../../src/cli/program';
import { wantsInteractive } from '../../src/cli/app';
import { addNode, readRoster } from '../../src/cli/roster';
import { COMMANDS, commandCatalog } from '../../src/cli/registry';
import { resolveSettings } from '../../src/cli/settings';
import { NODE } from '../../src/test-fixtures';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function settings() {
  const workspace = await mkdtemp(join(tmpdir(), 'personal-cli-test-'));
  directories.push(workspace);
  return { workspace, config: join(workspace, 'fleet.json') };
}

test('discovery, agent guide, schema and help need no roster or credentials', async () => {
  for (const args of [
    ['commands', '--json'],
    ['fleet-nodes', '--schema', '--json'],
    ['fleet-repair', '--list', '--json'],
    ['--help'],
    ['help'],
    ['help', 't3-apply'],
    ['fleet-node-add', '--help'],
  ]) {
    const result = await execute(args, await settings(), '1.2.3');
    expect(result.exitCode).toBe(0);
    expect(result.data).toBeObject();
  }
  expect(new Set(COMMANDS.map((entry) => entry.id)).size).toBe(COMMANDS.length);
  expect(
    COMMANDS.filter((entry) => entry.mutation).map((entry) => entry.id)
  ).toEqual([
    'fleet-sync',
    'fleet-node-sync',
    'fleet-repair',
    'fleet-node-add',
    't3-apply',
    't3-cleanup',
    'cliproxy',
  ]);
  expect(
    COMMANDS.every((entry) =>
      /^(fleet-|t3-|cliproxy$|commands$)/.test(entry.id)
    )
  ).toBe(true);
  expect(
    commandCatalog('docter').some((entry) => entry.id === 'fleet-status')
  ).toBe(true);
  expect(
    commandCatalog('ssh', 'Reference').every(
      (entry) => entry.group === 'Reference'
    )
  ).toBe(true);
  expect(commandCatalog('zzzzunfindablezzzzz')).toHaveLength(0);
});

test('interactive routing never prompts agents, redirected terminals or CI', () => {
  expect(wantsInteractive([], true, false)).toBe(false);
  expect(wantsInteractive(['--config', '/tmp/fleet.json'], true, false)).toBe(
    false
  );
  expect(wantsInteractive(['--interactive'], true, false)).toBe(true);
  expect(wantsInteractive(['--interactive'], true, true)).toBe(false);
  expect(wantsInteractive(['--interactive', 't3-cleanup'], true, false)).toBe(
    false
  );
  expect(wantsInteractive(['fleet-nodes'], true, false)).toBe(false);
  expect(wantsInteractive(['--json', '--interactive'], true, false)).toBe(
    false
  );
  expect(wantsInteractive(['--non-interactive'], true, false)).toBe(false);
  expect(wantsInteractive([], false, false)).toBe(false);
  expect(wantsInteractive([], true, true)).toBe(false);
});

test('usage errors never echo arbitrary option values or silently authorize mutation', async () => {
  const base = await settings();
  for (const args of [
    ['--unknown-secret=do-not-echo'],
    ['fleet-node-add', '--id', 'do-not-echo'],
    ['fleet-node-add', '--id', 'a', '--ssh', 'a', '--path', '/a', '--apply'],
    ['fleet-status', '--all', '--local'],
    ['fleet-status', '--tailnet', '--workers'],
    ['fleet-status', '--tailnet', '--node', 'do-not-echo'],
    ['fleet-status', '--timeout', 'not-a-number'],
    ['fleet-repair', '--list', '--local'],
    ['fleet-nodes', '--onboard', '--schema'],
    ['t3-apply', '--import', 'do-not-echo', '--dry-run'],
  ]) {
    const result = await execute(args, base, '1.2.3');
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
  }
  expect(await readRoster(base.config)).toBeNull();
});

test('register previews, explicit writes preserve nodes, and duplicates fail', async () => {
  const base = await settings();
  const args = [
    'fleet-node-add',
    '--id',
    'first',
    '--ssh',
    'first',
    '--path',
    '/workspace',
    '--json',
  ];
  expect((await execute(args, base, '1.2.3')).exitCode).toBe(0);
  expect(await readRoster(base.config)).toBeNull();
  expect(
    (await execute([...args, '--apply', '--yes'], base, '1.2.3')).exitCode
  ).toBe(0);
  await addNode(base.config, { ...NODE, id: 'second' }, true);
  expect((await readRoster(base.config))?.nodes.map((node) => node.id)).toEqual(
    ['first', 'second']
  );
  const before = await readFile(base.config, 'utf8');
  expect(
    (await execute([...args, '--apply', '--yes'], base, '1.2.3')).exitCode
  ).toBe(2);
  expect(await readFile(base.config, 'utf8')).toBe(before);
  const onboarding = await execute(
    ['fleet-nodes', '--onboard', '--node', 'first', '--json'],
    base,
    '1.2.3'
  );
  expect(onboarding.data).toMatchObject({
    nodes: [{ verifyCommand: 'devfleet fleet-status --node first --json' }],
  });
  if (process.platform !== 'win32')
    expect((await stat(base.config)).mode & 0o777).toBe(0o600);
});

test('concurrent writers fail closed rather than lose entries', async () => {
  const base = await settings();
  await writeFile(`${base.config}.lock`, '');
  await expect(addNode(base.config, NODE, true)).rejects.toThrow('locked');
  expect(await readRoster(base.config)).toBeNull();
});

test.skipIf(process.platform === 'win32')(
  'symlink rosters are refused without touching their target',
  async () => {
    const base = await settings();
    const target = join(base.workspace, 'target.json');
    await writeFile(target, JSON.stringify({ version: 1, nodes: [NODE] }));
    await symlink(target, base.config);
    await expect(
      addNode(base.config, { ...NODE, id: 'other' }, true)
    ).rejects.toThrow('regular file');
    expect(JSON.parse(await readFile(target, 'utf8')).nodes).toHaveLength(1);
  }
);

test('explicit configuration and workspace override environment defaults', async () => {
  const base = await settings();
  expect(
    await resolveSettings(base, base.workspace, {
      PERSONAL_WORKSPACE: '/wrong',
      PERSONAL_FLEET_CONFIG: '/wrong',
    })
  ).toEqual(base);
});

test('listing an unconfigured fleet is an empty first-run state; validation and unsafe rosters still fail', async () => {
  const base = await settings();
  const result = await execute(['fleet-nodes', '--json'], base, '1.2.3');
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ ok: true, configured: false, nodes: [] });
  expect(
    (await execute(['fleet-nodes', '--onboard', '--json'], base, '1.2.3'))
      .exitCode
  ).toBe(2);
  await writeFile(base.config, '{broken');
  expect(
    (await execute(['fleet-nodes', '--json'], base, '1.2.3')).exitCode
  ).toBe(2);
});

test('bare invocation is help; the command index carries the agent contract and release metadata', async () => {
  const base = await settings();
  const release = { version: '1.2.3', releasedAt: '2026-01-02T03:04:05.000Z' };
  const bare = await execute([], base, release);
  const help = await execute(['--help'], base, release);
  expect(bare.exitCode).toBe(0);
  expect(bare.text).toBe(help.text);
  expect(bare.text).toContain('Usage: devfleet');
  expect(bare.text).toContain('1.2.3 (released 2026-01-02T03:04:05.000Z)');
  expect(bare.text).toContain('--json does not make a command read-only');
  expect((await execute(['--version'], base, release)).text).toBe(
    '1.2.3 (released 2026-01-02T03:04:05.000Z)'
  );
  expect(
    (
      await execute(['--version'], base, {
        version: '0.0.0-development',
        releasedAt: null,
      })
    ).text
  ).toContain('unreleased source build');
  const catalog = await execute(['commands', '--json'], base, release);
  expect((await execute(['--json'], base, release)).data).toEqual(catalog.data);
  const data = catalog.data as {
    releasedAt: string;
    agent: { discovery: string };
    commands: { id: string; help: string; execution: { default: string } }[];
  };
  expect(data.releasedAt).toBe(release.releasedAt);
  expect(data.agent.discovery).toBe('devfleet commands --json');
  expect(
    data.commands.find((entry) => entry.id === 't3-apply')?.execution.default
  ).toBe('apply');
  expect(
    data.commands.find((entry) => entry.id === 'fleet-repair')?.execution
      .default
  ).toBe('preview');
  expect(
    data.commands.find((entry) => entry.id === 'fleet-status')?.execution
      .default
  ).toBe('read-only');
  expect(data.commands.every((entry) => entry.help.endsWith('--help'))).toBe(
    true
  );
  expect(await readRoster(base.config)).toBeNull();
});

test('every indexed command has read-only help without a checkout or credentials', async () => {
  const base = await settings();
  for (const entry of COMMANDS) {
    const result = await execute([...entry.args, '--help'], base, 'test');
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('Usage:');
  }
});
