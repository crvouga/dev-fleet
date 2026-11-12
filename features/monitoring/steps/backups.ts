import { expect } from 'bun:test';
import { resolve } from 'node:path';
import { loadDefinition } from '../../../src/definition';
import { backupVariables } from '../../../src/monitoring/manager-hub';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { monitoring, type MonitoringWorld } from './world';

/** The hub backups the fleet configuration declares. */
const { Given, When, Then } = monitoring;

const root = resolve(import.meta.dir, '../../..');
const prepared = new WeakMap<MonitoringWorld, Record<string, unknown>>();

Given(
  'the fleet configuration declares hub backups at {string}, keeping {int}',
  (world, schedule: string, keep: number) => {
    world.declaredBackups = {
      schedule,
      keep,
      storage: {
        bucket: 'never-output-bucket',
        endpoint: 'https://never-output.example',
        region: 'auto',
      },
    };
  }
);

Given(
  'the secret store holds {string} for {string} {string}',
  (world, value: string, path: string, field: string) => {
    world.otherwise = failed();
    world.commands.answer(
      (command) =>
        command[0] === 'vault' &&
        command.includes(`-field=${field}`) &&
        command.at(-1) === path,
      succeeded(`${value}\n`)
    );
  }
);

When(
  "the hub's backup variables are prepared from the example fleet configuration",
  async (world) => {
    world.otherwise ??= failed();
    prepared.set(
      world,
      await backupVariables(
        loadDefinition(resolve(root, 'examples/fleet.json')),
        world.run
      )
    );
  }
);

Then("the hub's backup variables are:", (world, table: DataTable) => {
  const variables = prepared.get(world) ?? {};
  expect(
    Object.fromEntries(
      Object.entries(variables).map(([key, value]) => [key, String(value)])
    )
  ).toEqual(
    Object.fromEntries(table.raw().map(([key, value]) => [key, value]))
  );
});

Then('no backup variables are handed over', (world) => {
  expect(prepared.get(world)).toEqual({});
});
