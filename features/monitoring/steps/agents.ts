import { expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadDefinition } from '../../../src/definition';
import { fleet } from '../../../src/fleet-config';
import { applyAgent, refusal } from '../../../src/monitoring/apply';
import { installManagerAgent } from '../../../src/monitoring/manager-agent';
import {
  TAILSCALE_APP_CLI,
  convergeManagerHub,
  managerHubPaths,
  tailscaleCommand,
} from '../../../src/monitoring/manager-hub';
import { installRemoteAgent } from '../../../src/monitoring/remote';
import { runCommand } from '../../../src/runner';
import { roleOf } from '../../../src/topology';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { commandLine } from '../../support/answers';
import { monitoring, type MonitoringWorld } from './world';

const { Given, When, Then } = monitoring;

const root = resolve(import.meta.dir, '../../..');

// ── The fleet these scenarios run in ─────────────────────────────────────

Given(
  'the example fleet, whose manager {string} is reached at {string} and serves the hub on port {int}',
  (world, manager: string, address: string, port: number) => {
    world.definition = loadDefinition(resolve(root, 'examples/fleet.json'));
    // The same fleet is the configuration in force for the whole run.
    for (const definition of [world.definition, fleet]) {
      expect(definition.manager.id).toBe(manager);
      expect(definition.manager.network.tailscaleName).toBe(address);
      expect<number>(definition.services.monitoring.hubPort).toBe(port);
    }
  }
);

Given(
  'the example fleet declares the worker {string} and no machine {string}',
  (_world, worker: string, stranger: string) => {
    expect(roleOf(fleet, worker)).toBe('worker');
    expect(roleOf(fleet, stranger)).toBeNull();
  }
);

// ── Playbooks ────────────────────────────────────────────────────────────

const ranPlaybook = (world: MonitoringWorld, playbook: string): boolean =>
  world.playbooks.some((run) => run.playbook === playbook);

Given('the playbook {string} succeeds', (world, playbook: string) => {
  world.commands.answer(
    (command) => command.includes(playbook),
    async (command) => {
      // Its variables are read while it runs: the file is gone afterwards.
      const variables: unknown = JSON.parse(
        await readFile(command.at(-1)!.slice(1), 'utf8')
      );
      world.playbooks.push({ playbook, variables });
      return succeeded();
    }
  );
});

Given(
  'until the playbook {string} has run the command {string} prints {string}, and afterwards:',
  (world, playbook: string, command: string, before: string, after: string) => {
    world.commands.answer(commandLine(command), () =>
      succeeded(ranPlaybook(world, playbook) ? after : before)
    );
  }
);

Given('no apply leaves a receipt', (world) => {
  // A directory that cannot be written: every apply runs in full.
  world.receipts = '/dev/null/receipts';
});

const ORDER = { first: 0, second: 1 } as const;
const run = (world: MonitoringWorld, order: string, playbook: string) => {
  const found = world.playbooks[ORDER[order as keyof typeof ORDER]];
  expect(found?.playbook).toBe(playbook);
  return found!.variables;
};

Then(
  /^the (first|second) playbook run, "([^"]+)", was given exactly these variables:$/,
  (world, order: string, playbook: string, table: DataTable) => {
    expect(run(world, order, playbook)).toEqual(table.rowsHash());
  }
);

Then(
  /^the (first|second) playbook run, "([^"]+)", was given these variables among others:$/,
  (world, order: string, playbook: string, table: DataTable) => {
    expect(run(world, order, playbook)).toMatchObject(table.rowsHash());
  }
);

Then(
  /^the (first|second) playbook run, "([^"]+)", was not given the variable "([^"]+)"$/,
  (world, order: string, playbook: string, variable: string) => {
    expect(run(world, order, playbook)).not.toHaveProperty(variable);
  }
);

Then('the playbook {string} was not run', (world, playbook: string) => {
  expect(
    world.commands.calls.some((call) => call.command.includes(playbook))
  ).toBe(false);
});

Then('the first command ran the playbook {string}', (world, playbook) => {
  expect(world.commands.calls[0]?.command).toContain(String(playbook));
});

Then('the second command was {string}', (world, line: string) => {
  expect(world.commands.calls[1]?.command).toEqual(line.split(' '));
});

Then('no {string} command was run', (world, name: string) => {
  expect(world.commands.calls.some((call) => call.command[0] === name)).toBe(
    false
  );
});

Then('a command was run with the argument {string}', (world, argument) => {
  expect(world.commands.calls.map((call) => call.command)).toContainEqual(
    expect.arrayContaining([String(argument)])
  );
});

// ── The hub on the manager ───────────────────────────────────────────────

Given("the home of the manager's user is {string}", (world, home: string) => {
  world.home = home;
});

Given("the manager's Tailscale CLI is {string}", (world, cli: string) => {
  world.tailscale = cli;
});

Given('the manager has no Tailscale CLI', (world) => {
  world.tailscale = null;
});

Given('the manager holds no fleet login for the hub', (world) => {
  world.account = null;
});

Given(
  'the manager holds the fleet login {string} with the password {string}',
  (world, identity: string, password: string) => {
    world.account = { identity, password };
  }
);

Given('the viewer of the dashboard is in place', (world) => {
  world.viewer = {
    id: 'beszel:public-viewer',
    status: 'pass',
    summary: 'viewer',
  };
});

Given("the hub's backups are in place", (world) => {
  world.backups = {
    id: 'beszel:backup',
    status: 'pass',
    summary: 'backups',
  };
});

When('the hub is converged on the manager', async (world) => {
  world.checks = await convergeManagerHub(root, world.definition!, world.run, {
    home: world.home,
    tailscale: world.tailscale,
    account: async () => world.account,
    viewer: async () => world.viewer!,
    backups: async () => world.backups!,
    ...(world.receipts ? { receipts: world.receipts } : {}),
  });
});

Then('these checks are reported:', (world, table: DataTable) => {
  const reported: Record<string, string>[] = world.checks.map((check) => ({
    check: check.id,
    status: check.status,
  }));
  expect(reported).toEqual(table.hashes());
});

Then('the summary of the second check is {string}', (world, summary) => {
  expect(world.checks[1]?.summary).toBe(String(summary));
});

Then(
  'with the PATH {string} and only {string} on disk, the Tailscale CLI is {string}',
  (_world, path: string, existing: string, cli: string) => {
    expect(tailscaleCommand(path, (candidate) => candidate === existing)).toBe(
      cli
    );
  }
);

Then(
  'with the PATH {string} and no Tailscale on disk, there is no Tailscale CLI',
  (_world, path: string) => {
    expect(tailscaleCommand(path, () => false)).toBeNull();
  }
);

Then('the Tailscale app keeps its CLI at {string}', (_world, path: string) => {
  expect(TAILSCALE_APP_CLI).toBe(path);
});

Then(
  'the hub of a manager whose home is {string} keeps its data in {string}',
  (_world, home: string, data: string) => {
    expect(managerHubPaths(home).data).toBe(data);
  }
);

// ── Agents ───────────────────────────────────────────────────────────────

Given('the agent is enrolled as:', (world, table: DataTable) => {
  const enrolled = table.rowsHash();
  world.enrollment = {
    systemId: enrolled['system'] ?? '',
    hubUrl: enrolled['hub'] ?? '',
    publicKey: enrolled['public key'] ?? '',
    token: enrolled['token'] ?? '',
  };
});

When(
  'the manager {string}, whose user is {int}, installs its own agent from the package at {string}',
  async (world, node: string, uid: number, packageRoot: string) => {
    world.checks = await installManagerAgent(
      packageRoot,
      { node, enrollment: world.enrollment! },
      world.run,
      { uid, ...(world.receipts ? { directory: world.receipts } : {}) }
    );
  }
);

Given('the worker answers over SSH with:', (world, answer: string) => {
  world.otherwise = succeeded(answer);
});

Given(
  "a worker's home that holds the revision {string}",
  async (world, revision: string) => {
    world.workerHome = await mkdtemp(join(tmpdir(), 'fleet-monitoring-lock-'));
    world.defer(() => rm(world.workerHome, { recursive: true, force: true }));
    await mkdir(
      join(world.workerHome, '.local/share/personal/fleet/revisions', revision),
      { recursive: true }
    );
  }
);

Given(
  'another operation holds the remote operation lock of that home',
  (world) => {
    // What would run on the worker runs here instead, inside a real flock(1)
    // on the same lock file.
    const lock = join(
      world.workerHome,
      '.local/share/personal/fleet/remote-operation.lock'
    );
    world.commands.answer(
      () => true,
      (command, options) =>
        runCommand(['flock', lock, 'sh', '-c', command.at(-1)!], {
          ...options,
          env: { HOME: world.workerHome },
        })
    );
  }
);

When(
  'the manager installs the agent on the worker {string} at the revision {string}',
  async (world, worker: string, revision: string) => {
    world.checks = await installRemoteAgent(
      { id: worker, ssh: worker, workspace: '/unused', required: [] },
      revision,
      world.enrollment!,
      world.run
    );
  }
);

Then("the worker's checks are exactly:", (world, table: DataTable) => {
  expect(world.checks.map((check) => check.id)).toEqual(table.list());
});

const sent = (world: MonitoringWorld): string => {
  const input = world.commands.calls[0]?.options?.input;
  expect(input).toBeString();
  return input!;
};

Then(
  'the worker was sent exactly, on standard input:',
  (world, expected: string) => {
    expect(JSON.parse(sent(world))).toEqual(JSON.parse(expected));
  }
);

Then('what the worker was sent does not contain {string}', (world, text) => {
  expect(sent(world)).not.toContain(String(text));
});

// ── What a machine accepts ───────────────────────────────────────────────

When(
  'the machine is asked, in the checkout {string}, to apply:',
  async (world, checkout: string, request: string) => {
    await world.attempt(async () => {
      world.checks = await applyAgent(
        JSON.parse(request),
        checkout,
        world.run,
        world.receipts ? { receipts: world.receipts } : {}
      );
    });
  }
);

When(
  'the worker {string} installs its agent for the hub {string}',
  async (world, worker: string, hub: string) => {
    world.checks = await applyAgent(
      {
        node: worker,
        revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hubUrl: hub,
        publicKey: 'ssh-ed25519 fixture',
        token: 'disposable-fixture-token',
      },
      '/fleet/checkout',
      world.run,
      { receipts: world.receipts ?? '/dev/null/receipts' }
    );
  }
);

const third = (world: MonitoringWorld) => {
  expect(world.checks.length).toBeGreaterThan(2);
  return world.checks[2]!;
};

Then('the summary of the third check is {string}', (world, summary) => {
  expect(third(world).summary).toBe(String(summary));
});

Then('the third check is skipped', (world) => {
  expect(third(world).status).toBe('skip');
});

When('an installation fails with the error {string}', (world, message) => {
  world.failure = new Error(String(message));
});

Then('it is refused with exactly {string}', (world, message: string) => {
  expect(world.failure).toBeInstanceOf(Error);
  expect((world.failure as Error).message).toBe(message);
});

const reported = (world: MonitoringWorld) => {
  expect(world.failure).toBeDefined();
  return refusal(world.failure);
};

Then('the refusal is reported with the summary {string}', (world, summary) => {
  expect(reported(world)[0]?.summary).toBe(String(summary));
});

Then('the remedy of the refusal contains {string}', (world, text: string) => {
  expect(reported(world)[0]?.remedy?.action).toContain(text);
});

Then('the reported refusal does not contain {string}', (world, text) => {
  expect(JSON.stringify(reported(world))).not.toContain(String(text));
});

// ── What the agent may see ───────────────────────────────────────────────

let unit = '';
When("the agent's systemd unit {string} is read", async (_world, path) => {
  unit = await readFile(resolve(root, String(path)), 'utf8');
});

const settings = (): string[] =>
  unit
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

Then(
  'it runs as the user {string} in the group {string}',
  (_world, user: string, group: string) => {
    expect(settings()).toContain(`User=${user}`);
    expect(settings()).toContain(`Group=${group}`);
  }
);

Then('it sets each of these:', (_world, table: DataTable) => {
  for (const setting of table.list()) expect(settings()).toContain(setting);
});

Then('it names none of these:', (_world, table: DataTable) => {
  for (const text of table.list())
    expect(settings().join('\n')).not.toContain(text);
});

let task: Record<string, unknown> = {};
When(
  'the task {string} of {string} is read',
  async (_world, name: string, path: string) => {
    const plays = parse(await readFile(resolve(root, path), 'utf8')) as {
      tasks: Record<string, unknown>[];
    }[];
    const found = plays
      .flatMap((play) => play.tasks)
      .find((t) => t['name'] === name);
    expect(found).toBeDefined();
    task = found!;
  }
);

const userModule = (): Record<string, unknown> =>
  task['ansible.builtin.user'] as Record<string, unknown>;

Then('it creates a system account without a login shell', () => {
  expect(userModule()['system']).toBe(true);
  expect(userModule()['shell']).toBe('/usr/sbin/nologin');
});

Then('it adds the account to no other group', () => {
  expect(userModule()).not.toHaveProperty('groups');
  expect(userModule()).not.toHaveProperty('append');
});

// ── The stock API ────────────────────────────────────────────────────────

let paths: string[] = [];
When(
  'the hub API paths named under {string} and in {string} are listed',
  async (_world, directory: string, file: string) => {
    const sources = [
      ...[...new Bun.Glob(`${directory}/*.ts`).scanSync({ cwd: root })],
      file,
    ];
    const found = new Set<string>();
    for (const source of sources) {
      const text = await readFile(resolve(root, source), 'utf8');
      for (const match of text.matchAll(/\/api\/[A-Za-z0-9_/.-]*/g))
        found.add(match[0].replace(/[/.]+$/, ''));
    }
    // The guard every reader applies ("a path under /api/") names no endpoint.
    found.delete('/api');
    paths = [...found].sort();
  }
);

Then('they are exactly:', (_world, table: DataTable) => {
  expect(paths).toEqual(table.list().sort());
});
