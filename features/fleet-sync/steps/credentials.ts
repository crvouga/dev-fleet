import { expect } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { runCommand } from '../../../src/runner';
import type { CommandResult, Runner } from '../../../src/types';
import type { VaultConfig } from '../../../src/vault-config';
import {
  issueWorkerToken,
  revokeWorkerToken,
  workerTokenLocation,
} from '../../../src/worker-credentials';
import { fleetSync, type FleetSyncWorld } from '../support/world';

/** A real Vault development server: the policies dev-fleet writes are
 * checked by Vault itself.
 */
const { Given, When, Then } = fleetSync;

interface DevVault {
  config: VaultConfig;
  root: string;
  tokens: Map<string, string>;
  answer?: CommandResult;
}
const servers = new WeakMap<FleetSyncWorld, DevVault>();

const server = (world: FleetSyncWorld): DevVault => {
  const found = servers.get(world);
  if (!found) throw new Error('The scenario has no Vault server.');
  return found;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No port'))
      );
    });
  });
}

/** Runs vault as `token`. */
const as =
  (vault: DevVault, token: string): Runner =>
  (command, options = {}) =>
    runCommand(command, {
      ...options,
      env: {
        ...options.env,
        VAULT_ADDR: vault.config.addr,
        VAULT_TOKEN: token,
      },
    });

Given(
  "a Vault development server holding the fleet's shared document",
  async (world) => {
    const port = await freePort();
    const root = `root-${randomUUID()}`;
    const child: ChildProcess = spawn(
      'vault',
      [
        'server',
        '-dev',
        `-dev-root-token-id=${root}`,
        `-dev-listen-address=127.0.0.1:${port}`,
      ],
      { stdio: 'ignore' }
    );
    world.defer(() => {
      child.kill('SIGKILL');
    });
    const vault: DevVault = {
      config: {
        addr: `http://127.0.0.1:${port}`,
        mount: 'secret',
        project: 'fleet',
        config: 'prd',
      },
      root,
      tokens: new Map(),
    };
    servers.set(world, vault);
    const run = as(vault, root);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await run(['vault', 'status'])).ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const shared = await run([
      'vault',
      'kv',
      'put',
      '-mount=secret',
      'fleet/prd',
      'CLIPROXY_FLEET_CLIENT_API_KEY=shared-proxy-key',
    ]);
    expect(shared.ok).toBe(true);
  }
);

Given(
  'the manager has issued {string} and {string} their tokens',
  async (world, first: string, second: string) => {
    const vault = server(world);
    const run = as(vault, vault.root);
    for (const id of [first, second]) {
      expect((await issueWorkerToken(id, run, vault.config)).status).toBe(
        'pass'
      );
      const location = workerTokenLocation(id, vault.config);
      const token = await run([
        'vault',
        'kv',
        'get',
        `-mount=${location.mount}`,
        '-field=token',
        location.path,
      ]);
      vault.tokens.set(id, token.stdout.trim());
    }
  }
);

When(
  '{string} reads the token document of {string} with its own token',
  async (world, reader: string, owner: string) => {
    const vault = server(world);
    const location = workerTokenLocation(owner, vault.config);
    vault.answer = await as(
      vault,
      vault.tokens.get(reader)!
    )([
      'vault',
      'kv',
      'get',
      `-mount=${location.mount}`,
      '-field=accessor',
      location.path,
    ]);
  }
);

When('the manager revokes the token of {string}', async (world, id: string) => {
  const vault = server(world);
  const check = await revokeWorkerToken(
    id,
    as(vault, vault.root),
    vault.config
  );
  expect(check.status).toBe('pass');
});

Then('Vault refuses it', (world) => {
  const answer = server(world).answer!;
  expect(answer.ok).toBe(false);
  expect(answer.stderr).toContain('permission denied');
});

Then('Vault answers it', (world) => {
  expect(server(world).answer!.ok).toBe(true);
});

Then(
  "{string} can read the fleet's shared document",
  async (world, id: string) => {
    const vault = server(world);
    const read = await as(
      vault,
      vault.tokens.get(id)!
    )([
      'vault',
      'kv',
      'get',
      '-mount=secret',
      '-field=CLIPROXY_FLEET_CLIENT_API_KEY',
      'fleet/prd',
    ]);
    expect(read.stdout.trim()).toBe('shared-proxy-key');
  }
);

const lookup = (vault: DevVault, id: string) =>
  as(vault, vault.tokens.get(id)!)(['vault', 'token', 'lookup']);

Then(
  'the earlier token of {string} no longer authenticates',
  async (world, id: string) => {
    expect((await lookup(server(world), id)).ok).toBe(false);
  }
);

Then('the token of {string} still authenticates', async (world, id: string) => {
  expect((await lookup(server(world), id)).ok).toBe(true);
});
