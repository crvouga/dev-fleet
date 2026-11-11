import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import example from '../../../examples/fleet.json';
import type { DataTable } from '../../support/gherkin';
import { parseConfig, selectNodes } from '../../../src/config';
import { enrolledRoster, parseDefinition } from '../../../src/definition';
import { hostId, hubUrl, roleOf, type Role } from '../../../src/topology';
import { parseWorkerPolicy } from '../../../src/worker-policy';
import type { FleetNode } from '../../../src/types';
import {
  attempt,
  control,
  core,
  need,
  root,
  type CoreWorld,
  type WrittenRoster,
} from './world';

/** The fleet configuration, the worker policy in it, and the roster. */
const { Given, When, Then } = core;

type Fields = Record<string, unknown>;

// ── The fleet configuration ──────────────────────────────────────────────

const written = (world: CoreWorld): Fields =>
  need(world, world.written, 'a fleet configuration');

/** Sets `services.proxy.owner`; `undefined` is a block that is not there. */
function set(target: Fields, path: string, value: unknown): void {
  const keys = path.split('.');
  let at = target;
  for (const key of keys.slice(0, -1)) at = at[key] as Fields;
  at[keys.at(-1)!] = value;
}

const workers = (world: CoreWorld): Fields[] =>
  written(world)['workers'] as Fields[];

function worker(world: CoreWorld, id: string): Fields {
  const found = workers(world).find((entry) => entry['id'] === id);
  if (!found) throw new Error(`The fleet configuration has no worker ${id}.`);
  return found;
}

Given('the example fleet configuration', (world) => {
  world.written = structuredClone(example) as Fields;
});

Given('it requires every worker to have:', (world, table: DataTable) => {
  const policy = written(world)['worker'] as Fields;
  expect(policy['requiredCapabilities']).toEqual(table.list());
});

Given(
  /^the fleet configuration sets "([^"]+)" to (.+)$/,
  (world, path: string, value: string) => {
    set(written(world), path, JSON.parse(value));
  }
);

Given(
  /^the fleet configuration sets "([^"]+)" to:$/,
  (world, path: string, value: string) => {
    set(written(world), path, JSON.parse(value));
  }
);

Given('the fleet configuration leaves out {string}', (world, path: string) => {
  set(written(world), path, undefined);
});

Given(
  'the fleet configuration lists only the worker {string}',
  (world, id: string) => {
    written(world)['workers'] = [worker(world, id)];
  }
);

Given(
  'the fleet configuration lists the worker {string} a second time',
  (world, id: string) => {
    workers(world).push(worker(world, id));
  }
);

Given(
  /^the fleet configuration sets the "([^"]+)" of the worker "([^"]+)" to (.+)$/,
  (world, field: string, id: string, value: string) => {
    worker(world, id)[field] = JSON.parse(value);
  }
);

When('the fleet configuration is read', async (world) => {
  await attempt(world, () => {
    world.definition = parseDefinition(written(world));
  });
});

const definition = (world: CoreWorld) =>
  need(world, world.definition, 'a fleet configuration that was read');

Then(
  'the manager is {string}, runs {string} and never sleeps on power',
  (world, id: string, os: string) => {
    const { manager } = definition(world);
    expect(manager.id).toBe(id);
    expect<string>(manager.os).toBe(os);
    expect(manager.neverSleepOnPower).toBe(true);
  }
);

Then('there is at least one worker', (world) => {
  expect(definition(world).workers.length).toBeGreaterThan(0);
});

Then('every worker runs {string}', (world, os: string) => {
  expect(definition(world).workers.every((entry) => entry.os === os)).toBe(
    true
  );
});

Then('the proxy is served at {string}', (world, endpoint: string) => {
  expect(definition(world).services.proxy.endpoint).toBe(endpoint);
});

Then('the monitoring hub is reached at {string}', (world, url: string) => {
  expect(hubUrl(definition(world))).toBe(url);
});

Then('machines take dev-fleet from {string}', (world, repository: string) => {
  expect(definition(world).source.repository).toBe(repository);
});

const ROLES: Record<string, Role | null> = {
  'the manager': 'manager',
  'a worker': 'worker',
  'no machine of the fleet': null,
};

Then(
  /^"([^"]+)" is (the manager|a worker|no machine of the fleet)$/,
  (world, id: string, role: string) => {
    expect(roleOf(definition(world), id)).toBe(ROLES[role] ?? null);
  }
);

Then(
  'the host name {string} is the fleet id {string}',
  (_world, hostname: string, id: string) => {
    expect(hostId(hostname)).toBe(id);
  }
);

// ── The worker policy ────────────────────────────────────────────────────

When(
  'the worker policy is read without {string} among its required capabilities',
  async (world, missing: string) => {
    const policy = written(world)['worker'] as Fields;
    const required = policy['requiredCapabilities'] as string[];
    // The capability is one the policy has, or leaving it out says nothing.
    expect(required).toContain(missing);
    await attempt(world, () =>
      parseWorkerPolicy({
        ...policy,
        requiredCapabilities: required.filter(
          (capability) => capability !== missing
        ),
      })
    );
  }
);

// ── The roster ───────────────────────────────────────────────────────────

const roster = (world: CoreWorld): WrittenRoster =>
  need(world, world.roster, 'a roster');

const list = (cell: string): string[] =>
  cell === 'nothing' ? [] : cell.split(',').map((item) => item.trim());

/** A row of a roster table: a worker that names no `required` column gets
 * none, which is not the same as requiring nothing.
 */
function entry(row: Record<string, string>): Fields {
  const { required, ...rest } = row;
  return {
    ...rest,
    ...(required === undefined ? {} : { required: list(required) }),
  };
}

function listed(world: CoreWorld, id: string): Fields {
  const found = roster(world).nodes.find((node) => node['id'] === id);
  if (!found) throw new Error(`The roster has no worker ${id}.`);
  return found;
}

Given('a roster of these workers:', (world, table: DataTable) => {
  world.roster = { version: 1, nodes: table.hashes().map(entry) };
});

Given('the roster has the version {int}', (world, version: number) => {
  roster(world).version = version;
});

Given(
  'the roster has the field {string} set to {string}',
  (world, field: string, value: string) => {
    roster(world)[field] = control(value);
  }
);

Given(
  'the worker {string} has the field {string} set to {string}',
  (world, id: string, field: string, value: string) => {
    listed(world, id)[field] = control(value);
  }
);

Given(
  'the roster lists the worker {string} {int} times and no other',
  (world, id: string, times: number) => {
    const node = listed(world, id);
    roster(world).nodes = Array.from({ length: times }, () => node);
  }
);

Given('the roster lists no worker', (world) => {
  roster(world).nodes = [];
});

When('the roster is read', async (world) => {
  await attempt(world, () => {
    world.config = parseConfig(roster(world));
  });
});

When('the roster at {string} is read', async (world, path: string) => {
  const file: unknown = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  await attempt(world, () => {
    world.config = parseConfig(file);
  });
});

When('the manager enrolls the workers of the roster', async (world) => {
  const declared = parseDefinition(written(world));
  await attempt(world, () => {
    world.config = enrolledRoster(declared, roster(world));
  });
});

const nodes = (world: CoreWorld): FleetNode[] =>
  need(world, world.config, 'a roster that was read').nodes;

function nodeNamed(world: CoreWorld, id: string): FleetNode {
  const found = nodes(world).filter((node) => node.id === id);
  expect(found.map((node) => node.id)).toEqual([id]);
  return found[0]!;
}

Then('it lists {int} worker(s)', (world, count: number) => {
  expect(nodes(world).length).toBe(count);
});

Then(
  'the worker {string} is required to have:',
  (world, id: string, table: DataTable) => {
    expect<string[]>(nodeNamed(world, id).required).toEqual(table.list());
  }
);

Then('the worker {string} is required to have nothing', (world, id: string) => {
  expect(nodeNamed(world, id).required).toEqual([]);
});

Then('the workers enrolled are:', (world, table: DataTable) => {
  expect(nodes(world) as unknown[]).toEqual(table.hashes().map(entry));
});

async function select(world: CoreWorld, ids: string[]): Promise<void> {
  const config = parseConfig(roster(world));
  await attempt(world, () => {
    world.selected = selectNodes(config, ids);
  });
}

When('no worker is named to select from the roster', (world) =>
  select(world, [])
);

When('the worker {string} is selected from the roster', (world, id: string) =>
  select(world, [id])
);

Then('the workers selected are, in this order:', (world, table: DataTable) => {
  expect(
    need(world, world.selected, 'a selection').map((node) => node.id)
  ).toEqual(table.list());
});

Then(
  /^the workspace pattern of "([^"]+)" (accepts|rejects) "(.*)"$/,
  (_world, path: string, verdict: string, workspace: string) => {
    const schema = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as {
      properties: {
        nodes: { items: { properties: { workspace: { pattern: string } } } };
      };
    };
    const pattern = new RegExp(
      schema.properties.nodes.items.properties.workspace.pattern
    );
    expect(pattern.test(control(workspace))).toBe(verdict === 'accepts');
  }
);
