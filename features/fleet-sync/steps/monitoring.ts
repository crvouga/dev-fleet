import { expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeFleet } from '../../../src/cli/fleet';
import {
  enrollManagerMonitoring,
  synchronizeMonitoringWith,
} from '../../../src/cli/fleet-sync-monitoring';
import {
  appendDashboardEvidence,
  dashboardUrl,
  managedHealthScope,
} from '../../../src/cli/managed-health';
import type { TailnetComputer } from '../../../src/tailscale';
import type { Check, NodeReport } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  definition,
  fleetSync,
  flags,
  forbid,
  nested,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** What only these steps keep between them. */
interface Monitoring {
  fetcher: typeof fetch | undefined;
  install: ((node: string, hubUrl: string) => Check[]) | undefined;
  installs: { node: string; hubUrl: string }[];
  scope: ReturnType<typeof managedHealthScope> | undefined;
  /** Bundles the source for a probe of another machine. */
  source: (() => Promise<string>) | undefined;
}
const states = new WeakMap<FleetSyncWorld, Monitoring>();

function state(world: FleetSyncWorld): Monitoring {
  let found = states.get(world);
  if (!found) {
    found = {
      fetcher: undefined,
      install: undefined,
      installs: [],
      scope: undefined,
      source: undefined,
    };
    states.set(world, found);
  }
  return found;
}

// ── The tailnet ──────────────────────────────────────────────────────────

const yes = (cell: string | undefined): boolean => cell === 'yes';

/** `tailscale status --json`, as Tailscale prints it for these computers. */
function status(computers: TailnetComputer[]): string {
  const peer = (computer: TailnetComputer) => ({
    ID: computer.id,
    HostName: computer.name,
    DNSName: `${computer.dns}.`,
    OS: computer.os,
    TailscaleIPs: computer.ips,
    Online: computer.online,
  });
  return JSON.stringify({
    BackendState: 'Running',
    Health: null,
    Self: peer(computers.find((computer) => computer.self)!),
    Peer: Object.fromEntries(
      computers
        .filter((computer) => !computer.self)
        .map((computer) => [computer.name, peer(computer)])
    ),
  });
}

Given('the tailnet shows these computers:', (world, table: DataTable) => {
  const computers: TailnetComputer[] = table.hashes().map((row) => ({
    id: row['id']!,
    name: row['name']!,
    dns: row['dns']!,
    os: row['os']!,
    ips: [row['address']!],
    online: yes(row['online']),
    self: yes(row['this computer']),
  }));
  world.tailnet = { ...world.tailnet, computers };
  world.commands.answer(
    (command) => command[0] === 'tailscale',
    succeeded(status(computers))
  );
});

Given('the tailnet shows no computer', (world) => {
  world.tailnet = { ...world.tailnet, computers: [] };
});

Given('the tailnet left out {int} mobile device', (world, count: number) => {
  world.tailnet = { ...world.tailnet, excludedMobile: count };
});

// ── The hub ──────────────────────────────────────────────────────────────

Given('the hub on the manager answers its health check', (world) => {
  world.commands.answer((command) => command[0] === 'curl', succeeded());
});

Given('the hub on the manager does not answer its health check', (world) => {
  world.commands.answer((command) => command[0] === 'curl', failed());
});

Given(
  /^the hub, at version "([^"]*)" with the key "([^"]*)", accepts the fleet login(?: as user "([^"]*)")?$/,
  (world, version: string, key: string, userId: string | undefined) => {
    world.hub = { version, key, userId: userId ?? '', system: null };
  }
);

Given('the hub has no system registered', (world) => {
  world.hub!.system = null;
});

Given(
  'the hub knows every machine as the system {string} with the status {string}, and has just received a sample',
  (world, id: string, status: string) => {
    world.hub!.system = { id, status };
  }
);

Given('logging in to the hub fails with {string}', (world, message: string) => {
  world.hubLogin = () => {
    throw new Error(message);
  };
});

Given('logging in to the hub would fail the scenario', (world) => {
  world.hubLogin = forbid(world, 'log in to the hub');
});

/** Logs in to the hub a scenario described. A scenario that described none
 * must not log in: nothing here reaches a real hub.
 */
function access(world: FleetSyncWorld) {
  return async (hub: string) => {
    if (world.hubLogin) world.hubLogin();
    const described = world.hub;
    if (!described) return forbid(world, 'log in to a hub nobody described')();
    world.hubLogins.push(hub);
    const now = (): string => new Date().toISOString();
    return {
      userId: described.userId,
      request: async (path: string, body?: object): Promise<unknown> => {
        if (body) {
          world.hubRecords.push(body);
          return body;
        }
        if (path.endsWith('/info'))
          return { v: described.version, key: described.key };
        if (path.includes('/systems/'))
          return { items: described.system ? [described.system] : [] };
        if (path.includes('/fingerprints/')) return { items: [] };
        // The newest sample of a system.
        return { items: [{ status: 'up', updated: now(), created: now() }] };
      },
    };
  };
}

Then('the hubs logged in to are exactly:', (world, table: DataTable) => {
  expect(world.hubLogins).toEqual(table.list());
});

Then('the first record sent to the hub has:', (world, table: DataTable) => {
  expect(world.hubRecords[0]).toMatchObject(nested(table));
});

// ── Enrolling a machine ──────────────────────────────────────────────────

Given(
  'every command on a worker answers with the check {string} as {string} with the summary {string}',
  (world, id: string, status: string, summary: string) => {
    world.commands.answer(
      (command) => !['curl', 'tailscale'].includes(command[0] ?? ''),
      succeeded(
        JSON.stringify({ version: 1, checks: [{ id, status, summary }] })
      )
    );
  }
);

Given(
  "installing the manager's own agent reports the check {string} as {string} with the summary {string}",
  (world, id: string, status: Check['status'], summary: string) => {
    state(world).install = (node, hubUrl) => {
      state(world).installs.push({ node, hubUrl });
      return [{ id, status, summary }];
    };
  }
);

When(
  'the monitoring of that machine is synchronized at revision {string}',
  async (world, revision: string) => {
    // A scenario never waits for the next sample.
    world.checks = await synchronizeMonitoringWith({
      sampleDeadlineMs: 0,
      access: access(world),
    })(world.node!, definition, revision, world.commands.run);
  }
);

When(
  'the monitoring of the manager is enrolled from the checkout {string}',
  async (world, checkout: string) => {
    const install =
      state(world).install ?? forbid(world, "install the manager's own agent");
    world.checks = await enrollManagerMonitoring(
      definition,
      checkout,
      world.commands.run,
      {
        sampleDeadlineMs: 0,
        access: access(world),
        install: async (_root, { node, enrollment }) =>
          install(node, enrollment.hubUrl),
      }
    );
  }
);

Then('the command run over SSH names {string}', (world, text: string) => {
  const ssh = world.commands.ran((command) => command[0] === 'ssh')[0] ?? [];
  expect(ssh.join(' ')).toContain(text);
});

Then(
  "the manager's own agent was installed exactly once, for {string} against the hub {string}",
  (world, node: string, hubUrl: string) => {
    expect(state(world).installs).toEqual([{ node, hubUrl }]);
  }
);

// ── The dashboard ────────────────────────────────────────────────────────

Given(
  'health reports, without any check yet, for:',
  (world, table: DataTable) => {
    world.reports = table.list().map((node) => ({ node, checks: [] }));
  }
);

Given('the hub and its public address answer their health checks', (world) => {
  state(world).fetcher = (async () =>
    new Response('{}', { status: 200 })) as unknown as typeof fetch;
});

Given(
  'every request to the hub fails with {string}',
  (world, message: string) => {
    state(world).fetcher = (async () => {
      throw new Error(message);
    }) as unknown as typeof fetch;
  }
);

When('the dashboard is looked up', (world) => {
  world.dashboard = dashboardUrl(world.tailnet);
});

When(
  'the evidence of the dashboard is added to the health reports',
  async (world) => {
    world.dashboard = await appendDashboardEvidence(
      world.reports,
      world.tailnet,
      {
        // Nothing here reaches a real hub: a scenario stands in for it.
        fetcher:
          state(world).fetcher ??
          (forbid(world, 'request a real hub') as unknown as typeof fetch),
        access: access(world),
      }
    );
  }
);

Then('the dashboard is at {string}', (world, url: string) => {
  expect(world.dashboard).toBe(url);
});

Then('there is no dashboard', (world) => {
  expect(world.dashboard).toBeNull();
});

const report = (reports: NodeReport[], node: string): NodeReport | undefined =>
  reports.find((entry) => entry.node === node);

Then(
  'the health report of {string} has exactly these checks:',
  (world, node: string, table: DataTable) => {
    expect(
      report(world.reports, node)?.checks.map((check) => ({
        check: check.id,
        status: check.status,
      }))
    ).toEqual(table.hashes() as { check: string; status: Check['status'] }[]);
  }
);

Then('the health reports do not mention {string}', (world, text: string) => {
  expect(JSON.stringify(world.reports)).not.toContain(text);
});

// ── The scope of managed health ──────────────────────────────────────────

When("the scope of the managed fleet's health is worked out", (world) => {
  state(world).scope = managedHealthScope(world.tailnet, world.roster);
});

Then('{int} computers are in scope', (world, count: number) => {
  expect(state(world).scope?.tailnet.computers).toHaveLength(count);
});

Then('{int} roster entries are in scope', (world, count: number) => {
  expect(state(world).scope?.nodes).toHaveLength(count);
});

Then('the computers left out are exactly:', (world, table: DataTable) => {
  expect(state(world).scope?.excluded).toEqual(table.list());
});

Then(
  '{int} checks are reported for the tailnet, every one with the status {string}',
  (world, count: number, status: string) => {
    const checks = state(world).scope?.tailnet.checks ?? [];
    expect(checks).toHaveLength(count);
    expect(checks.every((check) => check.status === status)).toBe(true);
  }
);

Then('no check is reported for the tailnet', (world) => {
  expect(state(world).scope?.tailnet.checks).toEqual([]);
});

// ── fleet-discover and fleet-health ──────────────────────────────────────

Given(
  'an empty workspace, and a roster file in it that does not exist',
  (world) => {
    const workspace = temporary(world, 'personal-tailnet-test-');
    world.settings = { workspace, config: join(workspace, 'fleet.json') };
  }
);

Given('the roster file holds:', (world, text: string) => {
  writeFileSync(world.settings.config, text);
});

Given(
  'every other command succeeds, and Git names the commit {string}',
  (world, commit: string) => {
    world.commands.answer(
      (command) => command[0] !== 'tailscale',
      (command) => succeeded(command.includes('rev-parse') ? commit : '')
    );
  }
);

Given('bundling the source would fail the scenario', (world) => {
  state(world).source = forbid(world, 'bundle the source');
});

When('the fleet is asked to {string}', async (world, text: string) => {
  const [command = '', ...rest] = text.split(' ');
  try {
    world.outcome = await executeFleet(
      command,
      flags(rest.join(' ')),
      world.settings,
      {
        run: world.commands.run,
        source: state(world).source ?? (async () => ''),
      }
    );
  } catch (error) {
    world.failure = error as Error;
  }
});

Then(
  'the report of the computer {string} has at least these checks:',
  (world, node: string, table: DataTable) => {
    const data = world.outcome?.data as { nodes: NodeReport[] };
    expect(report(data.nodes, node)?.checks).toEqual(
      expect.arrayContaining(
        table
          .hashes()
          .map((row) =>
            expect.objectContaining({ id: row['check'], status: row['status'] })
          )
      )
    );
  }
);
