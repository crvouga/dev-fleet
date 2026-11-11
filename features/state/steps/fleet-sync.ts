import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandOutcome } from '../../../src/cli/contracts';
import { managerSync, type ManagerSync } from '../../../src/cli/fleet-sync';
import { parseDefinition } from '../../../src/definition';
import { reloadFleet } from '../../../src/fleet-config';
import { parseBucket, writeBucket } from '../../../src/state/bucket';
import { STATE_ROSTER } from '../../../src/state/roster';
import { readDocument } from '../../../src/state/store';
import type { Runner } from '../../../src/types';
import {
  STATE,
  WHO,
  act,
  json,
  phrase,
  scratch,
  state,
  type StateWorld,
} from './world';

const { Given, When, Then } = state;

const sync = scratch<{
  /** How often a run started over after its state was replaced. */
  restarts: number;
  /** The enrollment document as the last run found it. */
  enrollmentBefore: string | null;
}>(() => ({ restarts: 0, enrollmentBefore: null }));

Given('fleet-sync runs on a manager with no worker enrolled', (world) => {
  const manager = world.manager();
  world.bind(manager);
  // Litestream answers; every other command is absent, as on a bare machine.
  const run: Runner = (argv, options) =>
    argv[0] === 'mise' || argv[0] === '/pinned/litestream'
      ? world.litestream.run(argv, options)
      : Promise.resolve({
          ok: false,
          stdout: '',
          stderr: '',
          reason: 'missing',
        });
  manager.run = run;
});

Given(
  phrase(WHO, ' saved the bucket "([^"]+)" in its bucket\\.json'),
  (world, name: string | undefined, directory: string) => {
    const manager = world.manager(name);
    manager.bucket = parseBucket({
      directory: world.expand(directory, manager),
    });
    writeBucket(manager.bucketFile, manager.bucket);
  }
);

Given(
  phrase('the process runs with the fleet\\.json "([^"]+)"'),
  (world, path: string) => {
    world.setEnv('DEVFLEET_CONFIG', world.expand(path, world.manager()));
    reloadFleet();
  }
);

/** fleet-sync on the manager this process is bound to. A run whose state was
 * replaced under it starts the same request over.
 */
function run(
  world: StateWorld,
  request: { revision: string; dryRun?: boolean }
): Promise<CommandOutcome> {
  const manager = world.manager();
  const settings = { workspace: '/no-checkout', config: STATE_ROSTER };
  const options = { ...request, json: true, nonInteractive: true };
  sync(world).enrollmentBefore = readDocument(manager.database, 'enrollment');
  const services: ManagerSync = {
    run: manager.run,
    root: join(manager.home, 'manager'),
    restart: () => {
      sync(world).restarts += 1;
      return managerSync(options, settings, services);
    },
  };
  return managerSync(options, settings, services);
}

Given(
  /^fleet-sync (runs|ran) for revision "([a-f0-9]{40})"$/,
  (world, verb: string, revision: string) =>
    act(world, verb, () => run(world, { revision }))
);
When(
  /^fleet-sync previews revision "([a-f0-9]{40})"$/,
  (world, revision: string) =>
    world.attempt(() => run(world, { revision, dryRun: true }))
);

Then('the run started over {int} time(s)', (world, count: number) => {
  expect(sync(world).restarts).toBe(count);
});

Then(
  phrase('the enrollment in ', STATE, ' is what it was before the run'),
  (world, name: string | undefined) => {
    expect(readDocument(world.manager(name).database, 'enrollment')).toBe(
      sync(world).enrollmentBefore
    );
  }
);

Then(
  phrase(
    STATE,
    ' holds the configuration that "([^"]+)" on ',
    WHO,
    ' declares'
  ),
  (
    world,
    holder: string | undefined,
    path: string,
    name: string | undefined
  ) => {
    const declared = json(
      readFileSync(world.expand(path, world.manager(name)), 'utf8')
    );
    expect(
      json(readDocument(world.manager(holder).database, 'definition')!)
    ).toEqual(parseDefinition(declared));
  }
);
