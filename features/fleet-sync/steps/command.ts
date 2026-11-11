import { expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeEnrollment } from '../../../src/cli/fleet-sync-enrollment';
import { selected } from '../../../src/cli/fleet-sync-remote';
import { managerSchedule } from '../../../src/cli/fleet-sync-schedule';
import { capabilities } from '../../../src/cli/options';
import { execute } from '../../../src/cli/program';
import { CAPABILITIES } from '../../../src/config';
import type { Platform } from '../../../src/platform/types';
import type { Capability, FleetNode } from '../../../src/types';
import type { DataTable } from '../../support/gherkin';
import {
  fleetSync,
  request,
  rosterEntry,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** What only these steps keep between them. */
interface Command {
  capabilities: Capability[] | undefined;
  schedule: { revision: string; config: string } | undefined;
  platform: Platform;
  removed: string[];
  discovered: FleetNode[];
  merged: FleetNode[] | undefined;
}
const states = new WeakMap<FleetSyncWorld, Command>();

function state(world: FleetSyncWorld): Command {
  let found = states.get(world);
  if (!found) {
    found = {
      capabilities: undefined,
      schedule: undefined,
      platform: {} as Platform,
      removed: [],
      discovered: [],
      merged: undefined,
    };
    states.set(world, found);
  }
  return found;
}

// ── The devfleet command line ────────────────────────────────────────────

When('the operator runs {string}', async (world, line: string) => {
  const [name, ...args] = line.split(' ');
  if (name !== 'devfleet') throw new Error(`Not devfleet: ${line}`);
  world.outcome = await execute(args, world.settings, world.version);
});

Given('the roster file enrolls:', (world, table: DataTable) => {
  const config = join(temporary(world, 'fleet-stale-'), 'fleet.json');
  writeFileSync(
    config,
    JSON.stringify({ version: 1, nodes: table.hashes().map(rosterEntry) })
  );
  world.settings = { ...world.settings, config };
});

When(
  'the manager applies {string} to the selected workers, approved for the plan fingerprint {string}',
  async (world, command: string, fingerprint: string) => {
    world.outcome = await selected(
      { ...request(command), expectedPlanFingerprint: fingerprint },
      world.settings,
      world.commands.run
    );
  }
);

When('the capabilities {string} are required', (world, value: string) => {
  state(world).capabilities = capabilities(value);
});

When('no capability is named', (world) => {
  state(world).capabilities = capabilities();
});

Then('no capability is required', (world) => {
  expect(state(world).capabilities).toEqual([]);
});

Then(
  'every capability dev-fleet knows is required, except {string}',
  (world, except: string) => {
    expect(state(world).capabilities).toEqual(
      CAPABILITIES.filter((entry) => entry !== except)
    );
  }
);

// ── The schedule ─────────────────────────────────────────────────────────

Given(
  'a schedule request for the revision {string} with the roster {string}',
  (world, revision: string, config: string) => {
    state(world).schedule = { revision, config };
  }
);

Given('a platform that can do nothing', (world) => {
  state(world).platform = {} as Platform;
});

Given(
  'the platform says the schedule is installed and supported, with the detail {string}',
  (world, detail: string) => {
    state(world).platform = {
      scheduledJobStatus: () => ({ installed: true, supported: true, detail }),
    } as unknown as Platform;
  }
);

Given(
  'the platform removes a scheduled job it is asked to, with the detail {string}',
  (world, detail: string) => {
    state(world).platform = {
      removeScheduledJob: (label: string) => {
        state(world).removed.push(label);
        return { ok: true, detail };
      },
    } as unknown as Platform;
  }
);

When(
  /^the schedule action "(enable|pause|resume|disable|status)" is requested (with|without) authorization$/,
  async (
    world,
    action: 'enable' | 'pause' | 'resume' | 'disable' | 'status',
    authorization: string
  ) => {
    world.outcome = await managerSchedule(
      {
        ...state(world).schedule!,
        action,
        authorized: authorization === 'with',
      },
      world.commands.run,
      state(world).platform
    );
  }
);

Then('the scheduled jobs removed are exactly:', (world, table: DataTable) => {
  expect(state(world).removed).toEqual(table.list());
});

// ── Enrollment ───────────────────────────────────────────────────────────

Given('discovery finds:', (world, table: DataTable) => {
  state(world).discovered = table.hashes().map(rosterEntry);
});

When('what discovery found is merged into the roster', (world) => {
  state(world).merged = mergeEnrollment(world.roster, state(world).discovered);
});

Then('the merged roster is exactly:', (world, table: DataTable) => {
  expect(state(world).merged).toEqual(table.hashes().map(rosterEntry));
});

Then('the roster it started from still enrolls:', (world, table: DataTable) => {
  expect(world.roster).toEqual(table.hashes().map(rosterEntry));
});
