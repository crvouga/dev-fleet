import { expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { succeeded } from '../../support/commands';
import { rememberEnvironment } from '../../../src/t3/pairing';
import { t3Ide } from '../../../src/ide/t3';
import type { FleetConfig, FleetNode } from '../../../src/types';
import { ide, ROOT, type IdeWorld } from './world';

const { Given, When, Then } = ide;

const rosters = new WeakMap<IdeWorld, string>();
const roster = (world: IdeWorld): string => rosters.get(world)!;
const read = (world: IdeWorld): FleetConfig =>
  JSON.parse(readFileSync(roster(world), 'utf8')) as FleetConfig;
const enrolled = (world: IdeWorld, id: string): FleetNode =>
  read(world).nodes.find((node) => node.id === id)!;

Given('a roster file that enrolls the worker {string}', (world, id: string) => {
  const path = join(world.directory('ide-roster-'), 'roster.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      nodes: [{ id, ssh: id, workspace: '/home/dev/fleet', required: ['t3'] }],
    })
  );
  rosters.set(world, path);
  // Nothing else answers: no tailnet, no other command.
  world.otherwise = { ok: false, stdout: '', stderr: '', reason: 'exit' };
});

Given(
  'the roster already enrolls {string} with the T3 environment {string}',
  (world, id: string, environment: string) => {
    const config = read(world);
    config.nodes.find((node) => node.id === id)!.t3EnvironmentId = environment;
    writeFileSync(roster(world), JSON.stringify(config));
  }
);

Given(
  'the worker reports the T3 environment {string} over SSH',
  (world, environmentId: string) => {
    world.commands.answer(
      (command) =>
        command[0] === 'ssh' &&
        command.join(' ').includes('.well-known/t3/environment'),
      succeeded(JSON.stringify({ environmentId }))
    );
  }
);

const links = (world: IdeWorld, listed: unknown[]): void => {
  world.commands.answer(
    (command) => command.join(' ') === 't3 environment list --json',
    succeeded(JSON.stringify(listed))
  );
};

Given(
  'the T3 of the manager links to {string}, reachable for {int} days',
  (world, environmentId: string, days: number) => {
    links(world, [
      {
        environmentId,
        status: 'reachable',
        expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      },
    ]);
  }
);

Given('the T3 of the manager has no links', (world) => {
  links(world, []);
});

When('the manager checks the T3 of the worker', async (world) => {
  const node = enrolled(world, 'dev-one');
  world.checks = await t3Ide().worker(node, {
    run: world.run,
    workspace: ROOT,
    earlier: [],
    remember: async (id, identity) => {
      await rememberEnvironment(roster(world), id, identity);
    },
  });
});

When(
  'the environment {string} is recorded for {string}',
  async (world, environment: string, id: string) => {
    try {
      await rememberEnvironment(roster(world), id, environment);
    } catch (error) {
      world.refusal = error;
    }
  }
);

Then('recording is refused', (world) => {
  expect(world.refusal).toBeDefined();
});

Then(
  'the roster enrolls {string} with the T3 environment {string}',
  (world, id: string, environment: string) => {
    expect(enrolled(world, id).t3EnvironmentId).toBe(environment);
  }
);

Then(
  'the roster enrolls {string} with no T3 environment',
  (world, id: string) => {
    expect(enrolled(world, id).t3EnvironmentId).toBeUndefined();
  }
);
