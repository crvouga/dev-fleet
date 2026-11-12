import { expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeEnrollment } from '../../../src/cli/fleet-sync-enrollment';
import { selected } from '../../../src/cli/fleet-sync-remote';
import {
  managerSchedule,
  release,
  type Release,
} from '../../../src/cli/fleet-sync-schedule';
import type { ScheduleRecord } from '../../../src/state/history';
import { succeeded } from '../../support/commands';
import { capabilities } from '../../../src/cli/options';
import { execute } from '../../../src/cli/program';
import { CAPABILITIES } from '../../../src/config';
import type { Platform, ScheduledJob } from '../../../src/platform/types';
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
  schedule:
    | {
        revision: string;
        config: string;
        release?: Release;
        root?: string;
        record?: (schedule: ScheduleRecord) => void;
      }
    | undefined;
  installed: ScheduledJob[];
  recorded: ScheduleRecord[];
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
      installed: [],
      recorded: [],
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

Given(
  /^the CLI is the published release "([^"]*)" (?:of the commit "([^"]*)"|built from no commit)$/,
  (world, version: string, revision: string | undefined) => {
    const schedule = state(world).schedule!;
    schedule.release = {
      ...release(),
      version,
      revision: revision ?? null,
    };
    schedule.root = temporary(world, 'fleet-schedule-');
    schedule.record = (record) => state(world).recorded.push(record);
  }
);

Given('npm installs any package it is asked to', (world) => {
  world.commands.answer((command) => command[0] === 'npm', succeeded());
});

Given('the platform installs a scheduled job it is asked to', (world) => {
  state(world).platform = {
    installScheduledJob: (job: ScheduledJob) => {
      state(world).installed.push(job);
      return { ok: true, detail: 'raw output' };
    },
  } as unknown as Platform;
});

Then('npm installed exactly {string}', (world, spec: string) => {
  const installs = world.commands.calls.filter(
    (call) => call.command[0] === 'npm'
  );
  expect(installs).toHaveLength(1);
  expect(installs[0]!.command.at(-1)).toBe(spec);
  expect(installs[0]!.command).toContain('--ignore-scripts');
});

Then(
  'the scheduled job {string} runs, every {int} minutes:',
  (world, label: string, minutes: number, table: DataTable) => {
    const [job] = state(world).installed;
    expect(job?.label).toBe(label);
    expect(job?.intervalSeconds).toBe(minutes * 60);
    const root = state(world).schedule!.root!;
    expect(job!.command.map((part) => part.replace(root, '{root}'))).toEqual(
      table.list()
    );
  }
);

Then(
  'the scheduled job runs with {string} set to {string}',
  (world, name: string, value: string) => {
    expect(state(world).installed[0]?.env[name]).toBe(value);
  }
);

Then(
  "the scheduled job's PATH names only the fleet's own tools and the system's",
  (world) => {
    const path = state(world).installed[0]?.env['PATH'] ?? '';
    for (const entry of path.split(':'))
      expect(entry).toMatch(
        /(\/\.local\/share\/mise\/shims|\/\.local\/bin|^\/opt\/homebrew\/bin|^\/usr\/local\/bin|^\/usr\/bin|^\/bin)$/
      );
    expect(path).not.toContain('node_modules');
  }
);

Then('no scheduled job was installed', (world) => {
  expect(state(world).installed).toEqual([]);
});

Then(
  /^the fleet state records the schedule as (on|off), every (\d+) minutes$/,
  (world, on: string, minutes: string) => {
    expect(
      state(world).recorded.map(({ enabled, intervalSeconds }) => ({
        enabled,
        intervalSeconds,
      }))
    ).toEqual([
      { enabled: on === 'on', intervalSeconds: Number(minutes) * 60 },
    ]);
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
