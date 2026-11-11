import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import policy from '../../../ansible/macos/policy.json';
import type { Account } from '../../../src/agents/accounts';
import {
  managerAgentProfiles,
  managerDocker,
  managerPower,
  pinnedDockerDesktop,
} from '../../../src/cli/fleet-sync-manager';
import { machineProviders } from '../../../src/t3/providers';
import type { Check, Status } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  ROOT,
  fleetSync,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** What these steps keep between them. */
interface Manager {
  accounts: Account[];
  /** T3's home on the manager. */
  t3Home: string | undefined;
  battery: Record<string, string>;
  /** What pmset reports on AC power. */
  power: Record<string, string>;
  /** One check for each setting reported as drifted in turn. */
  drifted: { setting: string; check: Check }[];
}
const managers = new WeakMap<FleetSyncWorld, Manager>();

function manager(world: FleetSyncWorld): Manager {
  let found = managers.get(world);
  if (!found) {
    found = {
      accounts: [],
      t3Home: undefined,
      battery: {},
      power: {},
      drifted: [],
    };
    managers.set(world, found);
  }
  return found;
}

// ── T3 providers ─────────────────────────────────────────────────────────

Given('the proxy has these accounts signed in:', (world, table: DataTable) => {
  manager(world).accounts = table.hashes().map((row) => ({
    tool: row['tool']!,
    email: row['email']!,
    prefix: row['prefix']!,
    models: row['models']!.split(',').map((model) => model.trim()),
  }));
});

Given('T3 on the manager is configured with:', (world, settings: string) => {
  const home = temporary(world, 'manager-t3-');
  mkdirSync(join(home, 'userdata'), { recursive: true });
  writeFileSync(join(home, 'userdata/settings.json'), settings);
  manager(world).t3Home = home;
});

function providers(
  world: FleetSyncWorld,
  id: string,
  apply: boolean
): Promise<Check> {
  const { accounts, t3Home } = manager(world);
  return machineProviders(id, ROOT, apply, {
    t3Home: t3Home!,
    roster: async () => accounts,
  });
}

Given(
  'the providers of {string} have been applied',
  async (world, id: string) => {
    expect((await providers(world, id, true)).status).toBe('pass');
  }
);

When(
  /^the providers of "([^"]*)" are (planned|applied)$/,
  async (world, id: string, action: string) => {
    world.checks = [await providers(world, id, action === 'applied')];
  }
);

function instances(world: FleetSyncWorld): Record<string, unknown> {
  const settings = JSON.parse(
    readFileSync(join(manager(world).t3Home!, 'userdata/settings.json'), 'utf8')
  ) as { providerInstances: Record<string, unknown> };
  return settings.providerInstances;
}

Then('T3 has exactly these provider instances:', (world, table: DataTable) => {
  expect(Object.keys(instances(world)).sort()).toEqual(table.list().sort());
});

Then('the provider instances of T3 are exactly:', (world, json: string) => {
  expect(instances(world)).toEqual(JSON.parse(json));
});

Then(
  'the provider instance {string} is displayed as {string}',
  (world, id: string, name: string) => {
    expect(instances(world)[id]).toMatchObject({ displayName: name });
  }
);

Then('the provider instances name {string}', (world, text: string) => {
  expect(JSON.stringify(instances(world))).toContain(text);
});

// ── Agent profiles ───────────────────────────────────────────────────────

Given('every agent profile applies cleanly', (world) => {
  world.commands.otherwise = succeeded();
});

Given(
  'every agent profile applies cleanly, except that of {string}',
  (world, tool: string) => {
    world.commands.otherwise = succeeded();
    world.commands.answer((argv) => argv.includes(tool), failed());
  }
);

When(
  'the agent profiles of {string} are applied',
  async (world, id: string) => {
    world.checks = await managerAgentProfiles(id, ROOT, world.commands.run);
  }
);

const after = (argv: string[], flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

Then(
  'a profile was applied for each of these tools, in this order:',
  (world, table: DataTable) => {
    expect(
      world.commands.calls.map((call) => after(call.command, '--tool'))
    ).toEqual(table.list());
  }
);

Then(/^every profile was applied with "([^"]*)"$/, (world, flag: string) => {
  for (const call of world.commands.calls) expect(call.command).toContain(flag);
});

Then(
  'every profile was applied with {string} set to {string}',
  (world, flag: string, value: string) => {
    for (const call of world.commands.calls)
      expect(after(call.command, flag)).toBe(value);
  }
);

// ── Power ────────────────────────────────────────────────────────────────

/** `pmset -g custom`, as macOS prints it. */
function pmset(world: FleetSyncWorld, power: Record<string, string>): void {
  const lines = (settings: Record<string, string>): string[] =>
    Object.entries(settings).map(
      ([key, value]) => ` ${key.padEnd(20)} ${value}`
    );
  world.commands.otherwise = succeeded(
    [
      'Battery Power:',
      ...lines(manager(world).battery),
      'AC Power:',
      ...lines(power),
    ].join('\n')
  );
}

Given('pmset reports on battery power:', (world, table: DataTable) => {
  manager(world).battery = table.rowsHash();
});

Given(
  /^pmset reports on AC power every setting the manager's power policy declares(?:, but "([^"]*)" as "([^"]*)")?$/,
  (world, setting: string | undefined, value: string | undefined) => {
    manager(world).power = {
      ...policy.pmset,
      ...(setting ? { [setting]: value ?? '' } : {}),
    };
  }
);

When('the power settings of the manager are measured', async (world) => {
  pmset(world, manager(world).power);
  world.checks = [await managerPower(world.commands.run)];
});

When(
  "each setting the manager's power policy declares, except {string}, is in turn reported as {string} on a manager whose checkout is {string}",
  async (world, except: string, value: string, checkout: string) => {
    for (const setting of Object.keys(policy.pmset).filter(
      (key) => key !== except
    )) {
      pmset(world, { ...policy.pmset, [setting]: value });
      manager(world).drifted.push({
        setting,
        check: await managerPower(world.commands.run, checkout),
      });
    }
  }
);

/** Every setting reported in turn: there has to be one, or nothing is said. */
function drifted(world: FleetSyncWorld): { setting: string; check: Check }[] {
  expect(manager(world).drifted.length).toBeGreaterThan(0);
  return manager(world).drifted;
}

Then("each time the check's status is {string}", (world, status: Status) => {
  for (const { check } of drifted(world)) expect(check.status).toBe(status);
});

Then(
  "each time the check's summary is {string} and the name of that setting",
  (world, code: string) => {
    for (const { setting, check } of drifted(world))
      expect(check.summary).toBe(`${code} ${setting}`);
  }
);

Then(
  "each time the check's remedy contains {string}",
  (world, text: string) => {
    for (const { check } of drifted(world))
      expect(check.remedy?.action).toContain(text);
  }
);

Then(
  "each time the check's remedy ends with {string}",
  (world, text: string) => {
    for (const { check } of drifted(world))
      expect(check.remedy?.action).toEndWith(text);
  }
);

// ── Docker Desktop ───────────────────────────────────────────────────────

Then(
  'the Docker Desktop that mise.toml pins is named "Docker Desktop", a release number and a build number in brackets',
  () => {
    expect(pinnedDockerDesktop()).toMatch(
      /^Docker Desktop \d+\.\d+\.\d+ \(\d+\)$/
    );
  }
);

Given(
  'the Docker engine names itself as the Docker Desktop that mise.toml pins',
  (world) => {
    world.commands.otherwise = succeeded(`${pinnedDockerDesktop()}\n`);
  }
);

Given('the Docker engine names itself {string}', (world, name: string) => {
  world.commands.otherwise = succeeded(`${name}\n`);
});

Given('the Docker engine does not answer', (world) => {
  world.commands.otherwise = failed();
});

When('the Docker Desktop of the manager is measured', async (world) => {
  world.checks = [await managerDocker(world.commands.run)];
});
