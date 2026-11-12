import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fleetNodeReplace,
  fleetNodeRetire,
  type NodeLifecycleOptions,
  type NodeLifecycleServices,
} from '../../../src/cli/fleet-node-lifecycle';
import { loadEnrollment, storeEnrollment } from '../../../src/state/enrollment';
import { stateContext } from '../../../src/state/sync';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { definition, fleetSync, type FleetSyncWorld } from '../support/world';
import { fleet } from '../../../src/fleet-config';
import type { HubRequest } from '../../../src/monitoring/enroll';
import { reconcileRecords } from '../../../src/cli/fleet-sync-records';
import { changeWorkers, readWorkerStates } from '../../../src/state/workers';
import { knownHostsPath } from '../../../src/ssh-connection';
import { declareFleet, workersOf } from '../../support/fleet';
import { tailnetCleanup } from '../../../src/tailnet-cleanup';
import { controlPlane, http } from './tailnet';

/** fleet-node-replace and fleet-node-retire, against a Vault, a tailnet and
 * Ansible that answer from memory.
 */
const { Given, When, Then } = fleetSync;

interface Lifecycle {
  directory: string;
  roster: string;
  /** What the token document of each worker holds: its accessor. */
  accessors: Map<string, string>;
  revoked: string[];
  issued: { node: string; policy: string; input?: string | undefined }[];
  playbooks: { name: string; variables: Record<string, unknown> }[];
  computers: { id: string; dns: string; online: boolean }[];
  clock: number;
  /** The systems the monitoring hub watches. */
  systems: { id: string; name: string; host: string }[];
}
const lifecycles = new WeakMap<FleetSyncWorld, Lifecycle>();

/** Made per run, so no credential-shaped literal is committed. */
const NEW_TOKEN = `placeholder-token-${randomUUID()}`;

function lifecycle(world: FleetSyncWorld): Lifecycle {
  let found = lifecycles.get(world);
  if (found) return found;
  const directory = mkdtempSync(join(tmpdir(), 'devfleet-lifecycle-'));
  const earlier = process.env['DEVFLEET_STATE'];
  process.env['DEVFLEET_STATE'] = join(directory, 'state');
  world.defer(() => {
    process.env['DEVFLEET_STATE'] = earlier;
    rmSync(directory, { recursive: true, force: true });
  });
  found = {
    directory,
    roster: join(directory, 'roster.json'),
    accessors: new Map(),
    revoked: [],
    issued: [],
    playbooks: [],
    computers: [],
    clock: Date.parse('2026-11-01T00:00:00Z'),
    systems: [],
  };
  lifecycles.set(world, found);
  vault(world, found);
  return found;
}

const node = (command: string[]): string =>
  /workers\/([a-z0-9-]+)$/.exec(
    command.find((arg) => arg.includes('workers/')) ?? ''
  )?.[1] ?? '';

/** A Vault that keeps each worker's token document in memory. */
function vault(world: FleetSyncWorld, state: Lifecycle): void {
  const { commands } = world;
  const is =
    (...words: string[]) =>
    (command: string[]) =>
      command[0] === 'vault' &&
      words.every((word, index) => command[index + 1] === word);
  commands.answer(is('kv', 'get'), (command) => {
    const accessor = state.accessors.get(node(command));
    return accessor ? succeeded(`${accessor}\n`) : failed();
  });
  commands.answer(is('token', 'revoke'), (command) => {
    state.revoked.push(command.at(-1)!);
    return succeeded();
  });
  commands.answer(is('kv', 'metadata', 'delete'), (command) => {
    state.accessors.delete(node(command));
    return succeeded();
  });
  commands.answer(is('policy'), succeeded());
  commands.answer(is('token', 'create'), (command) => {
    const policy = command.find((arg) => arg.startsWith('-policy='))!.slice(8);
    state.issued.push({ node: policy.replace('fleet-worker-', ''), policy });
    return succeeded(
      JSON.stringify({
        auth: { client_token: NEW_TOKEN, accessor: `acc-${policy}` },
      })
    );
  });
  commands.answer(is('kv', 'put'), (command, options) => {
    const accessor = command.find((arg) => arg.startsWith('accessor='))!;
    state.accessors.set(node([command.at(-3)!]), accessor.slice(9));
    state.issued.at(-1)!.input = options?.input;
    return succeeded();
  });
  commands.answer(
    (command) => command[0] === 'tailscale',
    () =>
      succeeded(
        JSON.stringify({
          BackendState: 'Running',
          Self: {
            ID: 'manager',
            HostName: 'manager-mac',
            DNSName: 'manager-mac-1.tail0a1b2c.ts.net.',
            OS: 'macOS',
            TailscaleIPs: ['100.64.0.1'],
            Online: true,
          },
          Peer: Object.fromEntries(
            state.computers.map((computer) => [
              computer.id,
              {
                ID: computer.id,
                HostName: computer.dns.split('.')[0],
                DNSName: `${computer.dns}.`,
                OS: 'linux',
                TailscaleIPs: ['100.64.0.2'],
                Online: computer.online,
              },
            ])
          ),
        })
      )
  );
}

/** A monitoring hub that keeps its systems in memory. */
function hub(state: Lifecycle): HubRequest {
  return async (path, body, method) => {
    const record = /\/systems\/records\/([a-z0-9]{15})$/.exec(path)?.[1];
    if (record && method === 'PATCH') {
      const system = state.systems.find((entry) => entry.id === record)!;
      system.host = (body as { host: string }).host;
      return system;
    }
    if (record && method === 'DELETE') {
      state.systems = state.systems.filter((entry) => entry.id !== record);
      return null;
    }
    if (path.includes('/fingerprints/')) return { items: [] };
    const name = /name="([^"]+)"/.exec(decodeURIComponent(path))?.[1];
    return {
      items: state.systems.filter((entry) => !name || entry.name === name),
    };
  };
}

export function services(world: FleetSyncWorld): NodeLifecycleServices {
  const state = lifecycle(world);
  return {
    run: world.commands.run,
    roster: state.roster,
    definition: () => fleet,
    monitoring: async () => hub(state),
    // The real cleanup, against the control plane the scenario declares.
    ...(controlPlane(world).config
      ? {
          tailnet: tailnetCleanup(
            controlPlane(world).config!,
            async (name) =>
              name === 'tailnet-admin' ? controlPlane(world).credential : null,
            http(world)
          ),
        }
      : {}),
    vault: () => true,
    knownHosts: join(state.directory, 'known_hosts'),
    state: () => stateContext(world.commands.run),
    playbook: async (name, variables) => {
      state.playbooks.push({
        name,
        variables: variables as Record<string, unknown>,
      });
      return true;
    },
    now: () => new Date((state.clock += 60_000)),
  };
}

const roster = (world: FleetSyncWorld) =>
  JSON.parse(readFileSync(lifecycle(world).roster, 'utf8')) as {
    nodes: { id: string; tailscaleId?: string }[];
  };

Given(
  'the manager has enrolled {string} and {string} from the example fleet, bound to the devices {string} and {string}',
  (world, first: string, second: string, one: string, two: string) => {
    const nodes = [
      [first, one],
      [second, two],
    ].map(([id, device]) => ({
      id,
      ssh: definition.workers.find((worker) => worker.id === id)!.ssh,
      workspace: `/home/dev/${id}`,
      tailscaleId: device,
    }));
    writeFileSync(
      lifecycle(world).roster,
      JSON.stringify({ version: 1, nodes })
    );
  }
);

Given(
  'the manager resolves the SSH alias {string} to {string}',
  (world, alias: string, host: string) => {
    lifecycle(world);
    world.commands.answer(
      (command) =>
        command[0] === 'ssh' && command[1] === '-G' && command[2] === alias,
      succeeded(`user dev\nhostname ${host}\nport 22\n`)
    );
  }
);

Given(
  'Vault holds the accessor {string} of the token of {string}',
  (world, accessor: string, id: string) => {
    lifecycle(world).accessors.set(id, accessor);
  }
);

Given(
  'the fleet state records that revision {string} was applied',
  (world, revision: string) => {
    lifecycle(world);
    storeEnrollment({
      version: 1,
      id: 'manager',
      approvedRevision: revision,
      appliedRevision: revision,
    });
  }
);

Given(
  /^the tailnet shows "([^"]+)" (?:online as the new device "([^"]+)"|offline)$/,
  (world, id: string, device: string | null) => {
    const dns = definition.workers.find((worker) => worker.id === id)!.network!
      .tailscaleName;
    lifecycle(world).computers = [
      { id: device ?? 'old-one', dns, online: device !== null },
    ];
  }
);

async function retire(world: FleetSyncWorld, apply: boolean, id: string) {
  const options: NodeLifecycleOptions = apply
    ? { id, apply, yes: true }
    : { id };
  return fleetNodeRetire(options, services(world));
}

async function replace(world: FleetSyncWorld, id: string, hostKey?: string) {
  return fleetNodeReplace(
    { id, apply: true, yes: true, ...(hostKey ? { hostKey } : {}) },
    services(world)
  );
}

Given('the operator has retired {string}', async (world, id: string) => {
  expect((await retire(world, true, id)).exitCode).toBe(0);
});

Given('the operator has replaced {string}', async (world, id: string) => {
  expect((await replace(world, id)).exitCode).toBe(0);
  lifecycle(world).issued = [];
});

When(
  /^the operator runs fleet-node-retire for "([^"]+)"( with --apply --yes)?$/,
  async (world, id: string, apply: string | undefined) => {
    world.outcome = await retire(world, Boolean(apply), id);
  }
);

When(
  /^the operator runs fleet-node-replace for "([^"]+)"(?: with the host key "([^"]+)" and| with) --apply --yes$/,
  async (world, id: string, hostKey: string | undefined) => {
    world.outcome = await replace(world, id, hostKey);
  }
);

const checks = (world: FleetSyncWorld) =>
  (
    world.outcome!.data as {
      nodes: { checks: { id: string; status: string }[] }[];
    }
  ).nodes[0]!.checks;

Then('the report lists these planned steps:', (world, table: DataTable) => {
  expect(checks(world).map((check) => check.id)).toEqual(table.list());
  expect(checks(world).every((check) => check.status === 'skip')).toBe(true);
});

Then('nothing was run on Vault or Ansible', (world) => {
  expect(world.commands.ran((command) => command[0] === 'vault')).toEqual([]);
  expect(lifecycle(world).playbooks).toEqual([]);
});

Then('the roster still holds {string}', (world, id: string) => {
  expect(roster(world).nodes.map((entry) => entry.id)).toContain(id);
});

Then('the roster holds only {string}', (world, id: string) => {
  expect(roster(world).nodes.map((entry) => entry.id)).toEqual([id]);
});

Then(
  'the roster binds {string} to {string}',
  (world, id: string, device: string) => {
    expect(
      roster(world).nodes.find((entry) => entry.id === id)?.tailscaleId
    ).toBe(device);
  }
);

Then(
  'Vault revoked the token with the accessor {string}',
  (world, accessor: string) => {
    expect(lifecycle(world).revoked).toEqual([accessor]);
  }
);

Then('no command line contains a Vault token', (world) => {
  for (const call of world.commands.calls)
    expect(call.command.join(' ')).not.toContain(NEW_TOKEN);
});

Then('Ansible forgot the host key of {string}', (world, host: string) => {
  expect(lifecycle(world).playbooks).toContainEqual({
    name: 'macos/worker-host-key.yml',
    variables: expect.objectContaining({ host, pin: 'absent' }),
  });
});

Then(
  'Ansible pinned {string} for {string}',
  (world, key: string, host: string) => {
    expect(lifecycle(world).playbooks).toContainEqual({
      name: 'macos/worker-host-key.yml',
      variables: expect.objectContaining({ host, key, pin: 'present' }),
    });
  }
);

Then(
  'Vault issued {string} a token under the policy {string}',
  (world, id: string, policy: string) => {
    expect(lifecycle(world).issued).toEqual([
      { node: id, policy, input: NEW_TOKEN },
    ]);
  }
);

Then('Vault issued no token', (world) => {
  expect(lifecycle(world).issued).toEqual([]);
});

Then(
  /^the fleet state records "([^"]+)" as retired(, at the time of the first retirement)?$/,
  async (_world, id: string, first: string | undefined) => {
    const enrollment = await loadEnrollment(null);
    expect(enrollment?.retired?.[id]).toBeString();
    if (first)
      expect(enrollment!.retired![id]).toBe('2026-11-01T00:01:00.000Z');
    expect(enrollment?.workers?.[id]).toBeUndefined();
  }
);

// ── What a replaced or retired worker leaves behind ──────────────────────

Given(
  'the monitoring hub watches {string} at {string}',
  (world, name: string, host: string) => {
    lifecycle(world).systems.push({
      id: `${name.replace(/[^a-z0-9]/g, '')}000000000000000`.slice(0, 15),
      name,
      host,
    });
  }
);

Given(
  'the roster records the T3 environment {string} of {string}',
  (world, environment: string, id: string) => {
    const state = lifecycle(world);
    writeFileSync(
      state.roster,
      JSON.stringify({
        version: 1,
        nodes: roster(world).nodes.map((node) =>
          node.id === id ? { ...node, t3EnvironmentId: environment } : node
        ),
      })
    );
    world.commands.answer(
      (command) => command[0] === 't3' && command[2] === 'unlink',
      succeeded()
    );
  }
);

Then('the monitoring hub watches only:', (world, table: DataTable) => {
  expect<object[]>(
    lifecycle(world).systems.map(({ name, host }) => ({ name, host }))
  ).toEqual(table.hashes());
});

Then(
  "the manager's T3 forgot the environment {string}",
  (world, environment: string) => {
    expect(
      world.commands.ran(
        (command) => command[0] === 't3' && command[2] === 'unlink'
      )
    ).toEqual([['t3', 'environment', 'unlink', environment]]);
  }
);

Then(
  'the roster records no T3 environment of {string}',
  (world, id: string) => {
    const entry = roster(world).nodes.find((node) => node.id === id) as
      { t3EnvironmentId?: string } | undefined;
    expect(entry?.t3EnvironmentId).toBeUndefined();
  }
);

Then(
  /^the report has the check "([^"]+)" (passed|skipped|warning), saying "([^"]+)"$/,
  (world, id: string, status: string, text: string) => {
    const wanted = { passed: 'pass', skipped: 'skip', warning: 'warn' }[status];
    const found = checks(world).filter(
      (check) => check.id === id && check.status === wanted
    ) as unknown as { summary: string }[];
    expect(found.map((check) => check.summary).join('\n')).toContain(text);
  }
);

Then(
  'the remedy of the check {string} says {string}',
  (world, id: string, text: string) => {
    const found = checks(world).find((check) => check.id === id) as
      { remedy?: { action: string } } | undefined;
    expect(found?.remedy?.action).toContain(text);
  }
);

Then(
  'the control plane was asked to delete only the device {string}',
  (world, device: string) => {
    expect(
      controlPlane(world)
        .requests.filter((request) => request.method === 'DELETE')
        .map((request) => request.url.split('/').at(-1))
    ).toEqual([device]);
  }
);

// ── A worker reached from declared data ──────────────────────────────────

Given(
  'fleet.json declares {string} with no SSH alias, so the roster reaches it by its tailnet name',
  (world, id: string) => {
    declareFleet(world, (declared) => {
      const worker = workersOf(declared).find((entry) => entry['id'] === id)!;
      delete worker['ssh'];
    });
    const state = lifecycle(world);
    const name = definition.workers.find((worker) => worker.id === id)!.network!
      .tailscaleName;
    writeFileSync(
      state.roster,
      JSON.stringify({
        version: 1,
        nodes: roster(world).nodes.map((node) =>
          node.id === id ? { ...node, ssh: name } : node
        ),
      })
    );
  }
);

Then(
  'the fleet state pins {string} for {string}',
  (_world, key: string, id: string) => {
    expect(readWorkerStates().workers[id]?.hostKey).toBe(key);
  }
);

Then('the fleet state pins no host key for {string}', (_world, id: string) => {
  expect(readWorkerStates().workers[id]?.hostKey).toBeUndefined();
});

Then('the fleet-owned known_hosts pins exactly:', (_world, pins: string) => {
  const lines = readFileSync(knownHostsPath(), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
  expect(lines).toEqual(pins ? pins.split('\n') : []);
});

Then('no personal known_hosts was changed', (world) => {
  expect(lifecycle(world).playbooks).toEqual([]);
});

// ── Workers that come and go with their records ──────────────────────────

function addToRoster(
  world: FleetSyncWorld,
  id: string,
  ssh: string,
  device: string
): void {
  writeFileSync(
    lifecycle(world).roster,
    JSON.stringify({
      version: 1,
      nodes: [
        ...roster(world).nodes,
        { id, ssh, workspace: `/home/dev/${id}`, tailscaleId: device },
      ],
    })
  );
}

Given(
  'the fleet state records that {string} was enrolled from a worker record, bound to the device {string}',
  async (world, id: string, device: string) => {
    addToRoster(world, id, `${id}.tail0a1b2c.ts.net`, device);
    await changeWorkers(stateContext(world.commands.run), () => ({
      [id]: { origin: 'records' },
    }));
  }
);

Given(
  'the roster still holds {string}, which fleet.json listed by hand',
  (world, id: string) => {
    addToRoster(world, id, id, `device-${id}`);
  }
);

When(
  /^fleet-sync reads the worker records( to preview them)?$/,
  async (world, preview: string | undefined) => {
    world.checks = await reconcileRecords(
      fleet,
      lifecycle(world).roster,
      world.commands.run,
      { apply: !preview, services: () => services(world) }
    );
  }
);

Then('fleet-sync reports:', (world, table: DataTable) => {
  expect<object[]>(
    world.checks.map((check) => ({ id: check.id, status: check.status }))
  ).toEqual(table.hashes());
});

Then('the roster holds {string}', (world, id: string) => {
  expect(roster(world).nodes.map((entry) => entry.id)).toContain(id);
});

Then('the roster does not hold {string}', (world, id: string) => {
  expect(roster(world).nodes.map((entry) => entry.id)).not.toContain(id);
});
