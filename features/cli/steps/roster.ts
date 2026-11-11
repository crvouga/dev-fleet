import { expect } from 'bun:test';
import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addNode, readRoster } from '../../../src/cli/roster';
import type { FleetNode } from '../../../src/types';
import type { DataTable } from '../../support/gherkin';
import { attempt, cli, listed, part, where } from './world';

const { Given, When, Then } = cli;

const roster = part(() => ({ linked: '' }));

/** The workers of a table: an ID, an SSH alias and a checkout path each,
 * with no capability required.
 */
function workers(table: DataTable): FleetNode[] {
  return table.hashes().map((row) => ({
    id: row['id']!,
    ssh: row['ssh']!,
    workspace: row['workspace']!,
    required: [],
  }));
}

Given('these workers are registered:', async (world, table: DataTable) => {
  for (const worker of workers(table))
    await addNode(where(world).config, worker, true);
});

Given('the roster file reads {string}', async (world, text: string) => {
  await writeFile(where(world).config, text);
});

Given('another writer holds the lock of the roster', async (world) => {
  await writeFile(`${where(world).config}.lock`, '');
});

Given(
  'the roster is a symbolic link to a file that lists these workers:',
  async (world, table: DataTable) => {
    const { config } = where(world);
    const target = join(dirname(config), 'target.json');
    await writeFile(
      target,
      JSON.stringify({ version: 1, nodes: workers(table) })
    );
    await symlink(target, config);
    roster(world).linked = target;
  }
);

When('this worker is added to the roster:', async (world, table: DataTable) => {
  await attempt(world, () =>
    addNode(where(world).config, workers(table)[0]!, true)
  );
});

Then('no roster is written', async (world) => {
  expect(await readRoster(where(world).config)).toBeNull();
});

Then('the roster lists the workers {string}', async (world, ids: string) => {
  expect(
    (await readRoster(where(world).config))?.nodes.map((node) => node.id)
  ).toEqual(listed(ids));
});

Then('the roster file is as it was', async (world) => {
  expect(world.rosterBefore).not.toBeNull();
  expect(await readFile(where(world).config, 'utf8')).toBe(world.rosterBefore!);
});

Then('only its owner can read or write the roster file', async (world) => {
  if (process.platform === 'win32') return;
  expect((await stat(where(world).config)).mode & 0o777).toBe(0o600);
});

Then(
  'the file the roster links to still lists {int} worker(s)',
  async (world, count: number) => {
    expect(
      (
        JSON.parse(await readFile(roster(world).linked, 'utf8')) as {
          nodes: unknown[];
        }
      ).nodes
    ).toHaveLength(count);
  }
);
