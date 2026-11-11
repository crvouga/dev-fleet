import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { executeFleet } from '../../src/cli/fleet';
import { gitRunner, NODE, workspace } from '../../src/test-fixtures';
import { probe } from '../../src/probe';
import type { Report, Runner } from '../../src/types';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await workspace();
  directories.push(root);
  return { workspace: root, config: join(root, 'fleet.json') };
}

test('local doctor never bundles a probe, reads a roster or contacts auth when unrequested', async () => {
  const commands: string[][] = [];
  const result = await executeFleet(
    'doctor',
    { local: true, require: 'none' },
    await fixture(),
    {
      source: () => {
        throw new Error('must not bundle');
      },
      run: async (command) => {
        commands.push(command);
        return gitRunner(command);
      },
    }
  );
  const report = result.data as Report & { coverage: { scope: string } };
  expect(report.nodes.map((node) => node.node)).toEqual(['manager']);
  expect(report.coverage.scope).toBe('local');
  expect(
    commands.every((command) => ['git', 'ssh-add'].includes(command[0]!))
  ).toBe(true);
});

test('all doctor still diagnoses manager but fails honestly without a fleet roster', async () => {
  const result = await executeFleet(
    'doctor',
    { all: true, require: 'none' },
    await fixture(),
    {
      source: () => {
        throw new Error('must not bundle');
      },
      run: gitRunner,
    }
  );
  expect(result.exitCode).toBe(1);
  const report = result.data as Report;
  expect(report.nodes.some((node) => node.node === 'manager')).toBe(true);
  expect(
    report.nodes
      .flatMap((node) => node.checks)
      .some((check) => check.id === 'fleet:roster' && check.status === 'fail')
  ).toBe(true);
});

test('all configured nodes use the supplied standalone probe; selected scope limits SSH', async () => {
  const base = await fixture();
  const nodes = [
    { ...NODE, id: 'one' },
    { ...NODE, id: 'two' },
  ];
  await writeFile(base.config, JSON.stringify({ version: 1, nodes }));
  const snapshot = await probe(base.workspace, [], gitRunner);
  const targets: string[][] = [];
  const run: Runner = async (command, options) => {
    if (command[0] !== 'ssh') return gitRunner(command);
    targets.push(command);
    expect(options?.input).toBe('standalone-probe-source');
    return {
      ok: true,
      stdout: JSON.stringify(snapshot),
      stderr: '',
      reason: 'exit',
    };
  };
  const services = { run, source: async () => 'standalone-probe-source' };
  const all = await executeFleet('doctor', { require: 'none' }, base, services);
  expect((all.data as Report).nodes.map((node) => node.node)).toEqual([
    'manager',
    'one',
    'two',
  ]);
  expect(targets).toHaveLength(2);
  targets.splice(0);
  const selected = await executeFleet(
    'doctor',
    { node: ['two'], require: 'none' },
    base,
    services
  );
  expect((selected.data as Report).nodes.map((node) => node.node)).toEqual([
    'manager',
    'two',
  ]);
  expect(targets).toHaveLength(1);
});
