import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import example from '../../examples/fleet.json';
import { parseDefinition } from '../../src/definition';
import {
  configPath,
  definitionSource,
  fleet,
  installConfig,
  reloadFleet,
} from '../../src/fleet-config';
import { actAsOperator, isOperator } from '../../src/state/operator';
import { databasePath, definitionPath, stateRoot } from '../../src/state/paths';
import { readDocument, writeDocument } from '../../src/state/store';

const EXAMPLE = resolve(import.meta.dir, '../../examples/fleet.json');
const roots: string[] = [];
afterEach(async () => {
  actAsOperator(null);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fleet-definition-'));
  roots.push(path);
  return path;
}

test('the configuration is read on first use and behaves like the plain object', () => {
  const expected = parseDefinition(example);
  expect(fleet.manager.id).toBe(expected.manager.id);
  expect(Object.keys(fleet)).toEqual(Object.keys(expected));
  expect('workers' in fleet).toBe(true);
  expect(JSON.stringify(fleet, null, 2)).toBe(
    JSON.stringify(expected, null, 2)
  );
  expect({ ...fleet }).toEqual(expected);
});

test('a missing configuration fails the command that needs it, not every command', async () => {
  const directory = await home();
  const named = process.env['DEVFLEET_CONFIG'];
  try {
    process.env['DEVFLEET_CONFIG'] = join(directory, 'absent.json');
    reloadFleet();
    expect(() => fleet.manager).toThrow('fleet-state --init');
    writeFileSync(
      process.env['DEVFLEET_CONFIG'],
      readFileSync(EXAMPLE, 'utf8').replaceAll('manager-mac', 'another-mac')
    );
    expect(fleet.manager.id).toBe('another-mac');
  } finally {
    process.env['DEVFLEET_CONFIG'] = named;
    reloadFleet();
  }
  expect(fleet.manager.id).toBe('manager-mac');
});

test('launchers read the installed copy; only the devfleet CLI reads the fleet state', async () => {
  const directory = await home();
  const env: NodeJS.ProcessEnv = {};
  const root = stateRoot(env, directory);
  const installed = join(directory, '.config/dev-fleet/fleet.json');
  writeDocument(
    databasePath(root),
    'definition',
    readFileSync(EXAMPLE, 'utf8')
  );
  // Not the CLI (a launcher, a scheduled job, the worker probe).
  expect(isOperator()).toBe(false);
  expect(definitionSource(env, directory)).toEqual({
    kind: 'installed',
    path: installed,
  });
  expect(configPath(env, directory)).toBe(installed);
  expect(definitionSource({ DEVFLEET_CONFIG: '/repo/fleet.json' })).toEqual({
    kind: 'file',
    path: '/repo/fleet.json',
  });

  actAsOperator((state) => readDocument(databasePath(state), 'definition'));
  // A file named explicitly still wins.
  expect(
    definitionSource({ DEVFLEET_CONFIG: '/repo/fleet.json' }, directory).kind
  ).toBe('file');
  expect(definitionSource(env, directory)).toEqual({
    kind: 'state',
    path: definitionPath(root),
  });
  // The commands this one starts are handed the same configuration as a file.
  const copy = configPath(env, directory);
  expect(copy).toBe(definitionPath(root));
  expect(env['DEVFLEET_CONFIG']).toBe(copy);
  expect(statSync(copy).mode & 0o077).toBe(0);
  expect(readFileSync(copy, 'utf8')).toBe(readFileSync(EXAMPLE, 'utf8'));
  expect(definitionSource(env, directory).kind).toBe('state');
  // A machine whose state holds no configuration falls back to its copy.
  const empty = await home();
  expect(definitionSource({}, empty).kind).toBe('installed');
});

test('fleet-sync installs the configuration it ran with as the machine copy', async () => {
  const directory = await home();
  mkdirSync(join(directory, '.config'), { recursive: true });
  expect(installConfig(directory)).toBe(true);
  expect(installConfig(directory)).toBe(false);
  const installed = join(directory, '.config/dev-fleet/fleet.json');
  expect(JSON.parse(readFileSync(installed, 'utf8'))).toEqual(
    parseDefinition(example)
  );
  expect(statSync(installed).mode & 0o077).toBe(0);
});

test('the probe workers run under Node never loads the state database', async () => {
  const { bundleProbe } = await import('../../src/transport');
  expect(await bundleProbe()).not.toContain('bun:sqlite');
});
