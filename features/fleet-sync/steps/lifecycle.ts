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

export function services(world: FleetSyncWorld): NodeLifecycleServices {
  const state = lifecycle(world);
  return {
    run: world.commands.run,
    roster: state.roster,
    definition: () => definition,
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
