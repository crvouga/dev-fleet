import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  enrollManager,
  type EnrollmentResult,
} from '../../../src/cli/fleet-sync-enrollment';
import { managerText } from '../../../src/cli/fleet-sync-output';
import { reportEnrollment } from '../../../src/cli/fleet-sync-remote';
import type { ManagerReport } from '../../../src/manager-sync';
import type { FleetConfig } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { validate } from '../../support/json-schema';
import {
  definition,
  fleetSync,
  ROOT,
  temporary,
  type FleetSyncWorld,
} from '../support/world';
import { arrival } from './arrival';
import { controlPlane } from './tailnet';

/** Enrollment by a run without a person, against a tailnet and workers that
 * answer from memory, and the report it ends in.
 */
const { Given, When, Then } = fleetSync;

interface Unattended {
  roster: string;
  result?: EnrollmentResult;
  report?: ManagerReport;
}
const runs = new WeakMap<FleetSyncWorld, Unattended>();

function unattended(world: FleetSyncWorld): Unattended {
  let found = runs.get(world);
  if (!found) {
    found = {
      roster: join(temporary(world, 'devfleet-enroll-'), 'roster.json'),
    };
    runs.set(world, found);
  }
  return found;
}

/** The SSH command a session runs is its last argument; the alias the one
 * before it.
 */
const session =
  (alias: string, ending: string) =>
  (command: string[]): boolean =>
    command[0] === 'ssh' &&
    command.at(-2) === alias &&
    (command.at(-1) ?? '').endsWith(ending);

Given('the manager has enrolled no worker yet', (world) => {
  unattended(world);
});

Given(
  'every SSH alias resolves to its own name in the tailnet {string}',
  (world, tailnet: string) => {
    world.commands.answer(
      (command) => command[0] === 'ssh' && command[1] === '-G',
      (command) => succeeded(`hostname ${command.at(-1)}.${tailnet}\n`)
    );
  }
);

Given('{string} cannot be reached over SSH', (world, alias: string) => {
  world.commands.answer(
    (command) => command[0] === 'ssh' && command.at(-2) === alias,
    failed(`ssh: connect to host ${alias} port 22: Connection refused`)
  );
});

function status(devices: { id: string; dns: string }[]): string {
  const peer = (id: string, dns: string, index: number) => ({
    ID: id,
    HostName: dns.split('.')[0],
    DNSName: `${dns}.`,
    OS: 'linux',
    TailscaleIPs: [`100.64.0.${index + 2}`],
    Online: true,
  });
  return JSON.stringify({
    BackendState: 'Running',
    Health: [],
    Self: { ...peer('nManager', 'manager-mac.example.ts.net', 0), OS: 'macOS' },
    Peer: Object.fromEntries(
      devices.map((device, index) => [
        device.id,
        peer(device.id, device.dns, index + 1),
      ])
    ),
  });
}

Given('the tailnet shows these devices:', (world, table: DataTable) => {
  const devices = table.hashes() as { id: string; dns: string }[];
  world.commands.answer(
    (command) => command[0] === 'tailscale',
    succeeded(status(devices))
  );
});

Given('the tailnet shows no devices', (world) => {
  world.commands.answer(
    (command) => command[0] === 'tailscale',
    succeeded(status([]))
  );
});

Given(
  '{string} answers a fresh SSH session with the home {string}',
  (world, alias: string, home: string) => {
    world.commands.answer(session(alias, '"$HOME"'), succeeded(home));
  }
);

Given(
  '{string} refuses the declared account until the account playbook runs, then answers with the home {string}',
  (world, alias: string, home: string) => {
    world.commands.answer(session(alias, '"$HOME"'), () =>
      arrival(world).applied.some(
        (entry) => entry.name === 'ubuntu/worker-account.yml'
      )
        ? succeeded(home)
        : failed(`${alias}: Permission denied (publickey).`)
    );
  }
);

Given('{string} has passwordless sudo', (world, alias: string) => {
  world.commands.answer(session(alias, 'sudo -n true'), succeeded());
});

Given('{string} asks for a sudo password', (world, alias: string) => {
  world.commands.answer(
    session(alias, 'sudo -n true'),
    failed('sudo: a password is required')
  );
});

When('fleet-sync enrolls without a person', async (world) => {
  const state = unattended(world);
  const config = controlPlane(world).config;
  state.result = await enrollManager(state.roster, world.commands.run, {
    interactive: false,
    joinable: Boolean(config),
    definition: config ? { ...definition, tailnet: config } : definition,
    playbook: (name, variables) => {
      arrival(world).applied.push({
        name,
        variables: variables as Record<string, unknown>,
      });
      return Promise.resolve(
        arrival(world).playbooks.get(name) ?? failed('no answer')
      );
    },
  });
});

const result = (world: FleetSyncWorld): EnrollmentResult => {
  const found = unattended(world).result;
  expect(found).toBeDefined();
  return found!;
};

const roster = (world: FleetSyncWorld): FleetConfig =>
  JSON.parse(readFileSync(unattended(world).roster, 'utf8')) as FleetConfig;

Then('the run enrolled:', (world, table: DataTable) => {
  expect(result(world).enrolled).toEqual(table.list());
});

Then('the run enrolled nobody', (world) => {
  expect(result(world).enrolled).toEqual([]);
});

Then(
  'the run reports {string} with {string}',
  (world, node: string, summary: string) => {
    expect(
      result(world).checks.some(
        (entry) => entry.node === node && entry.check.summary.includes(summary)
      )
    ).toBe(true);
  }
);

Then(
  'the roster binds {string} to the tailnet device {string}, with the workspace {string}',
  (world, id: string, device: string, workspace: string) => {
    const entry = roster(world).nodes.find((node) => node.id === id);
    expect(entry).toMatchObject({ tailscaleId: device, workspace });
    expect(entry?.bootstrapViaSsh).toBeUndefined();
  }
);

Then(
  'the roster lets {string} bootstrap over SSH, with the workspace {string}',
  (world, id: string, workspace: string) => {
    const entry = roster(world).nodes.find((node) => node.id === id);
    expect(entry).toMatchObject({ bootstrapViaSsh: true, workspace });
    expect(entry?.tailscaleId).toBeUndefined();
  }
);

// ── The report ───────────────────────────────────────────────────────────

Given(
  'a fleet-sync report of {string} and {string}',
  (world, first: string, second: string) => {
    const node = (id: string) => ({
      node: id,
      role: 'worker' as const,
      checks: [
        { id: 'ubuntu:baseline', status: 'pass' as const, summary: 'Applied' },
      ],
      reachability: 'online' as const,
      desiredRevision: 'a'.repeat(40),
      appliedRevision: 'a'.repeat(40),
      durationMs: 1,
    });
    unattended(world).report = {
      version: 3,
      command: 'fleet-sync',
      execution: 'manager-push',
      ok: true,
      applied: true,
      desiredRevision: 'a'.repeat(40),
      checks: [],
      nodes: [node(first), node(second)],
      candidates: 0,
      dashboardUrl: null,
    };
  }
);

When("the run's enrollment of {string} is added to it", (world, id: string) => {
  reportEnrollment(unattended(world).report!, { enrolled: [id], checks: [] });
});

Then('the report lists {string} as enrolled', (world, id: string) => {
  expect(unattended(world).report!.enrolled).toEqual([id]);
});

Then('its text says {string}', (world, text: string) => {
  expect(managerText(unattended(world).report!)).toContain(text);
});

Then('it matches {string}', (world, schema: string) => {
  expect(
    validate(
      join(ROOT, schema),
      JSON.parse(JSON.stringify(unattended(world).report))
    )
  ).toEqual([]);
});
