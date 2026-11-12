import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import policy from '../../../ansible/macos/policy.json';
import type { Account } from '../../../src/agents/accounts';
import { fleet } from '../../../src/fleet-config';
import {
  managerAgentProfiles,
  managerDocker,
  convergeManagerPolicy,
  managerPower,
  pinnedDockerDesktop,
} from '../../../src/cli/fleet-sync-manager';
import { machineProviders } from '../../../src/t3/providers';
import { MACOS_MANAGER } from '../../../src/platform/manager-host';
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

Given(
  "pmset reports on AC power every setting the manager's power policy declares except {string}",
  (world, absent: string) => {
    manager(world).power = Object.fromEntries(
      Object.entries(policy.pmset).filter(([key]) => key !== absent)
    );
  }
);

When('the power settings of the manager are measured', async (world) => {
  pmset(world, manager(world).power);
  world.checks = [await managerPower(world.commands.run)];
});

// ── The manager playbook, its receipt and its check-mode run ────────────

/** How the stand-in playbook behaves, and what the manager holds. */
interface Playbook {
  check: 'passes' | 'fails';
  apply: 'passes' | 'fails';
  /** Whether launchd holds the fleet-watch job. */
  watching: boolean;
  /** Where the receipts and variables of the scenario are kept. */
  receipts?: string;
  scratch?: string;
  /** The variables the playbook was last given. */
  variables?: Record<string, unknown>;
}
const playbooks = new WeakMap<FleetSyncWorld, Playbook>();

function playbook(world: FleetSyncWorld): Playbook {
  let found = playbooks.get(world);
  if (!found) {
    found = { check: 'passes', apply: 'passes', watching: true };
    playbooks.set(world, found);
  }
  return found;
}

const managerPlaybookRuns = (world: FleetSyncWorld) =>
  world.commands.ran((command) =>
    command.some((arg) => arg.endsWith('ansible/macos/manager.yml'))
  );

Given(
  /^the manager playbook (passes|fails) its check(?: and (passes|fails) when applied)?$/,
  (world, check: 'passes' | 'fails', apply?: 'passes' | 'fails') => {
    playbook(world).check = check;
    if (apply) playbook(world).apply = apply;
  }
);

Given("launchd does not hold the manager's watch job", (world) => {
  playbook(world).watching = false;
});

/** One applying sync of the manager's policy, `hours` after the first. */
async function convergePolicy(world: FleetSyncWorld, hours: number) {
  const kept = playbook(world);
  kept.receipts ??= temporary(world, 'manager-receipts-');
  kept.scratch ??= temporary(world, 'manager-variables-');
  pmset(world, { ...policy.pmset });
  world.commands.answer(
    (command) => command[0] === '/bin/launchctl' && command[1] === 'print',
    () => (kept.watching ? succeeded('state = waiting') : failed())
  );
  world.commands.answer(
    (command) =>
      command.some((arg) => arg.endsWith('ansible/macos/manager.yml')),
    (command) => {
      const file = command.at(-1)!.replace(/^@/, '');
      kept.variables = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >;
      const stage = command.includes('--check') ? kept.check : kept.apply;
      if (stage === 'fails') return failed();
      if (!command.includes('--check')) kept.watching = true;
      return succeeded();
    }
  );
  world.checks = [
    await convergeManagerPolicy(
      world.commands.run,
      { manager: { ...fleet.manager } },
      MACOS_MANAGER,
      {
        root: ROOT,
        receipts: kept.receipts,
        scratch: kept.scratch,
        uid: 501,
        now: Date.parse('2026-11-01T08:00:00Z') + hours * 3_600_000,
      }
    ),
  ];
}

Given("an applying sync converged the manager's policy", async (world) => {
  await convergePolicy(world, 0);
});

When("an applying sync converges the manager's policy", async (world) => {
  await convergePolicy(world, 0);
});

When(
  "an applying sync converges the manager's policy {int} hours later",
  async (world, hours: number) => {
    await convergePolicy(world, hours);
  }
);

Then('manager.yml was run, in this order:', (world, table: DataTable) => {
  expect(
    managerPlaybookRuns(world).map((command) =>
      command.includes('--check') ? 'check mode' : ('applied' as string)
    )
  ).toEqual(table.list());
});

Then('manager.yml was never run with a password prompt', (world) => {
  const runs = managerPlaybookRuns(world);
  expect(runs.length).toBeGreaterThan(0);
  for (const command of runs) {
    expect(command).not.toContain('-K');
    expect(command).not.toContain('--ask-become-pass');
  }
});

Then(
  'manager.yml was given the watch interval of {int} minutes',
  (world, minutes: number) => {
    expect(playbook(world).variables).toEqual({ fleet_watch_minutes: minutes });
  }
);

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
