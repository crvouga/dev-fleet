import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  fleetNodeSeed,
  type NodeSeedOptions,
} from '../../../src/cli/fleet-node-seed';
import type { SecretName } from '../../../src/secrets';
import { succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  definition,
  fleetSync,
  ROOT,
  type FleetSyncWorld,
} from '../support/world';
import { services } from './lifecycle';
import { controlPlane, http } from './tailnet';

/** fleet-node-seed, with ssh-keygen and the secrets provider answered here. */
const { Given, When, Then } = fleetSync;

interface Seeding {
  directory: string;
  secrets: Partial<Record<SecretName, string>>;
  refusal?: Error;
}
const seedings = new WeakMap<FleetSyncWorld, Seeding>();

function seeding(world: FleetSyncWorld): Seeding {
  let found = seedings.get(world);
  if (!found) {
    const directory = mkdtempSync(join(tmpdir(), 'devfleet-seed-test-'));
    world.defer(() => rmSync(directory, { recursive: true, force: true }));
    found = { directory, secrets: {} };
    seedings.set(world, found);
  }
  return found;
}

const output = (world: FleetSyncWorld) =>
  join(seeding(world).directory, 'seed.yaml');
const seed = (world: FleetSyncWorld) => readFileSync(output(world), 'utf8');
const userData = (world: FleetSyncWorld) =>
  parse(seed(world)) as Record<string, unknown>;

Given("the manager's public key is {string}", (world, key: string) => {
  writeFileSync(join(seeding(world).directory, 'manager.pub'), `${key}\n`);
});

Given(
  'the secrets provider holds these secrets:',
  (world, table: DataTable) => {
    Object.assign(seeding(world).secrets, table.rowsHash());
  }
);

Given(
  'the secrets provider holds a Tailscale auth key generated for this scenario',
  (world) => {
    // Made here, so no credential-shaped literal is ever committed.
    seeding(world).secrets['tailnet-auth-key'] = [
      'tskey',
      'auth',
      randomUUID(),
    ].join('-');
  }
);

Then('nothing printed or answered contains the auth key', (world) => {
  const key = seeding(world).secrets['tailnet-auth-key']!;
  expect(JSON.stringify(world.outcome)).not.toContain(key);
  for (const call of world.commands.calls)
    expect(call.command.join(' ')).not.toContain(key);
  expect(seed(world)).toContain(key);
});

const issued = (world: FleetSyncWorld): string =>
  (controlPlane(world).answer.body as { key: string }).key;

Then(
  'the seed carries the key the control plane issued, and not the stored one',
  (world) => {
    expect(seed(world)).toContain(issued(world));
    expect(seed(world)).not.toContain(
      seeding(world).secrets['tailnet-auth-key']!
    );
  }
);

Then(
  'nothing printed or answered contains the key the control plane issued',
  (world) => {
    expect(JSON.stringify(world.outcome)).not.toContain(issued(world));
    for (const call of world.commands.calls)
      expect(call.command.join(' ')).not.toContain(issued(world));
  }
);

Then('the seed joins with {string}', (world, argument: string) => {
  const joined = commands(world).find((line) =>
    line.startsWith('tailscale up')
  );
  expect(joined?.split(' ')).toContain(argument);
});

Given('ssh-keygen makes the host key {string}', (world, key: string) => {
  world.commands.answer(
    (command) => command[0] === 'ssh-keygen',
    (command) => {
      const path = command[command.indexOf('-f') + 1]!;
      writeFileSync(
        path,
        'placeholder host private key, written by the stand-in for ssh-keygen\n'
      );
      writeFileSync(`${path}.pub`, `${key}\n`);
      return succeeded();
    }
  );
});

When(
  /^the operator seeds "([^"]+)"(?: with (--autoinstall|--apply --yes))?$/,
  async (world, id: string, flag: string | null) => {
    const options: NodeSeedOptions = {
      id,
      output: output(world),
      publicKey: join(seeding(world).directory, 'manager.pub'),
      ...(flag === '--autoinstall' ? { autoinstall: true } : {}),
      ...(flag === '--apply --yes' ? { apply: true, yes: true } : {}),
    };
    const lifecycle = services(world);
    try {
      world.outcome = await fleetNodeSeed(options, {
        run: world.commands.run,
        playbook: lifecycle.playbook,
        knownHosts: lifecycle.knownHosts,
        state: lifecycle.state,
        now: lifecycle.now,
        definition: () =>
          controlPlane(world).config
            ? { ...definition, tailnet: controlPlane(world).config! }
            : definition,
        http: http(world),
        secret: async (name) =>
          name === 'tailnet-admin'
            ? controlPlane(world).credential
            : (seeding(world).secrets[name] ?? null),
        home: seeding(world).directory,
      });
    } catch (error) {
      seeding(world).refusal = error as Error;
    }
  }
);

Then('the seed is private to the operator', (world) => {
  expect(statSync(output(world)).mode & 0o077).toBe(0);
});

const at = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (current, key) => (current as Record<string, unknown> | undefined)?.[key],
      value
    );

Then('the seed is cloud-init user data where:', (world, table: DataTable) => {
  expect(seed(world).startsWith('#cloud-config\n')).toBe(true);
  for (const { field, value } of table.hashes())
    expect(String(at(userData(world), field!))).toBe(value!);
});

const commands = (world: FleetSyncWorld) =>
  (userData(world)['runcmd'] as string[][]).map((command) => command.join(' '));

Then(
  'the seed installs the Tailscale version ansible\\/ubuntu\\/policy.json pins',
  (world) => {
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'ansible/ubuntu/policy.json'), 'utf8')
    ) as { tailscale: { version: string; keySha256: string } };
    expect(commands(world)).toContain(
      `apt-get install --yes tailscale=${policy.tailscale.version}`
    );
    expect(
      commands(world).some((line) => line.includes(policy.tailscale.keySha256))
    ).toBe(true);
  }
);

Then('the seed deletes the auth key once the machine has joined', (world) => {
  const lines = commands(world);
  const joined = lines.findIndex((line) => line.startsWith('tailscale up'));
  expect(joined).toBeGreaterThan(-1);
  expect(lines[joined]).toContain(
    '--auth-key=file:/run/devfleet/tailnet-auth-key'
  );
  expect(lines.slice(joined + 1)).toContain(
    'rm -f /run/devfleet/tailnet-auth-key'
  );
});

Then('the answer names the host key {string}', (world, key: string) => {
  expect((world.outcome!.data as { hostKey: string }).hostKey).toBe(key);
});

Then('the seed contains none of these:', (world, table: DataTable) => {
  for (const value of table.list()) expect(seed(world)).not.toContain(value);
});

Then(
  'the seed is an autoinstall file whose user data names the host {string}',
  (world, host: string) => {
    const document = userData(world) as {
      autoinstall: { version: number; 'user-data': Record<string, unknown> };
    };
    expect(document.autoinstall.version).toBe(1);
    expect(document.autoinstall['user-data']['hostname']).toBe(host);
  }
);

Then('the seed is refused with {string}', (world, text: string) => {
  expect(seeding(world).refusal?.message).toContain(text);
});
