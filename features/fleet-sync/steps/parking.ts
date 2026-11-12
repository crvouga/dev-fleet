import { expect } from 'bun:test';
import {
  fleetNodePark,
  fleetNodeResume,
  type NodeParkServices,
} from '../../../src/cli/fleet-node-park';
import { readWorkerStates } from '../../../src/state/workers';
import { ACTIVITY_PROBE } from '../../../src/worker-activity';
import { failed, succeeded } from '../../support/commands';
import { declareFleet } from '../../support/fleet';
import { fleetSync, type FleetSyncWorld } from '../support/world';
import { services } from './lifecycle';

/** fleet-node-park and fleet-node-resume, against workers whose T3 answers
 * from the scenario, and a fleet-sync that is only recorded.
 */
const { Given, When, Then } = fleetSync;

interface Parking {
  synced: string[];
  syncOk: boolean;
  hooks: string[][];
}
const parkings = new WeakMap<FleetSyncWorld, Parking>();
function parking(world: FleetSyncWorld): Parking {
  let found = parkings.get(world);
  if (!found) {
    found = { synced: [], syncOk: true, hooks: [] };
    parkings.set(world, found);
  }
  return found;
}

function parkServices(world: FleetSyncWorld): NodeParkServices {
  const lifecycle = services(world);
  return {
    run: world.commands.run,
    roster: lifecycle.roster,
    definition: lifecycle.definition,
    state: lifecycle.state,
    now: lifecycle.now,
    sync: async (id) => {
      parking(world).synced.push(id);
      const ok = parking(world).syncOk;
      return { exitCode: ok ? 0 : 1, data: { ok }, text: '' };
    },
  };
}

Given(
  'fleet.json declares the stop command {string} and the start command {string}',
  (world, stop: string, start: string) => {
    declareFleet(world, (fleet) => {
      fleet['parking'] = { stop: stop.split(' '), start: start.split(' ') };
    });
    for (const command of [stop, start])
      world.commands.answer(
        (argv) => argv.join(' ').startsWith(command),
        (argv) => {
          parking(world).hooks.push(argv);
          return succeeded();
        }
      );
  }
);

Given('the stop command fails', (world) => {
  world.commands.answer(
    (argv) => argv[0] !== 'ssh' && argv[0] !== 'vault',
    (argv) => {
      parking(world).hooks.push(argv);
      return failed();
    }
  );
});

Given(
  /^the T3 of "([^"]+)" (runs \d+ agent turns?|runs no agent turn|cannot say what it runs|does not answer)$/,
  (world, id: string, what: string) => {
    const count = /^runs (\d+)/.exec(what)?.[1];
    const answer = what.startsWith('runs no')
      ? succeeded(
          `3600.5\n${JSON.stringify({ version: 1, running: 0, lastActivity: null })}\n`
        )
      : count
        ? succeeded(
            `3600.5\n${JSON.stringify({ version: 1, running: Number(count), lastActivity: null })}\n`
          )
        : what.startsWith('cannot')
          ? succeeded(
              `3600.5\n${JSON.stringify({ version: 1, unknown: true })}\n`
            )
          : failed('ssh: connect to host: Connection refused');
    world.commands.answer(
      (argv) =>
        argv[0] === 'ssh' &&
        argv.at(-1) === ACTIVITY_PROBE &&
        argv.includes(id),
      answer
    );
  }
);

Given('the fleet-sync after a resume does not end ready', (world) => {
  parking(world).syncOk = false;
});

When(
  /^the operator parks "([^"]+)"( with --force)?$/,
  async (world, id: string, force: string | undefined) => {
    world.outcome = await fleetNodePark(
      { id, ...(force ? { force: true } : {}) },
      parkServices(world)
    );
  }
);

When('the operator resumes {string}', async (world, id: string) => {
  world.outcome = await fleetNodeResume({ id }, parkServices(world));
});

Given('the operator has parked {string}', async (world, id: string) => {
  const outcome = await fleetNodePark({ id, force: true }, parkServices(world));
  expect(outcome.exitCode).toBe(0);
  parking(world).hooks = [];
});

Then(
  'the fleet state records {string} as parked at {string}',
  (_world, id: string, at: string) => {
    expect(readWorkerStates().workers[id]?.parkedAt).toBe(at);
  }
);

Then('the fleet state records {string} as active', (_world, id: string) => {
  expect(readWorkerStates().workers[id]?.parkedAt).toBeUndefined();
});

Then('the declared commands ran:', (world, table: { list(): string[] }) => {
  expect(parking(world).hooks.map((argv) => argv.join(' '))).toEqual(
    table.list()
  );
});

Then('no declared command ran', (world) => {
  expect(parking(world).hooks).toEqual([]);
});

Then('fleet-sync ran for {string} only', (world, id: string) => {
  expect(parking(world).synced).toEqual([id]);
});
