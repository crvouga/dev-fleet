import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeFleet } from '../../src/cli/fleet';
import { gitRunner, success } from '../../src/test-fixtures';
import type { Runner } from '../../src/types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function settings() {
  const workspace = await mkdtemp(join(tmpdir(), 'personal-tailnet-test-'));
  roots.push(workspace);
  return { workspace, config: join(workspace, 'fleet.json') };
}
const inventory = JSON.stringify({
  BackendState: 'Running',
  Health: null,
  Self: {
    ID: 'self',
    HostName: 'self',
    DNSName: 'self.tailnet.ts.net.',
    OS: 'linux',
    TailscaleIPs: ['100.64.0.1'],
    Online: true,
  },
  Peer: {
    one: {
      ID: 'remote',
      HostName: 'remote',
      DNSName: 'remote.tailnet.ts.net.',
      OS: 'macOS',
      TailscaleIPs: ['100.64.0.2'],
      Online: false,
    },
  },
});

test('discovery requires neither roster nor workspace health, and never attempts SSH/auth', async () => {
  const calls: string[][] = [];
  const result = await executeFleet('discover', {}, await settings(), {
    run: async (command) => {
      calls.push(command);
      return success(inventory);
    },
    source: async () => {
      throw new Error('must not bundle');
    },
  });
  expect(calls).toEqual([['tailscale', 'status', '--json']]);
  expect(result.exitCode).toBe(0);
  expect(result.data).toMatchObject({ ok: true, coverage: { computers: 2 } });
});

test('health retains offline and unregistered computers and cannot certify partial coverage', async () => {
  const run: Runner = async (command) =>
    command[0] === 'tailscale' ? success(inventory) : gitRunner(command);
  const result = await executeFleet('health', {}, await settings(), {
    run,
    source: async () => {
      throw new Error('must not bundle');
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({
    ok: false,
    coverage: { computers: 2, verified: false },
  });
  const data = result.data as {
    nodes: { node: string; checks: { id: string; status: string }[] }[];
  };
  expect(
    data.nodes.find((node) => node.node === 'remote.tailnet.ts.net')?.checks
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'tailscale:online', status: 'fail' }),
      expect.objectContaining({ id: 'fleet:registration', status: 'fail' }),
    ])
  );
});

test('health rejects malformed rosters and options that would silently narrow checks', async () => {
  const base = await settings();
  const services = {
    run: async () => success(inventory),
    source: async () => '',
  };
  for (const option of [
    { local: true },
    { all: true },
    { node: ['one'] },
    { require: 'none' },
  ]) {
    await expect(
      executeFleet('health', option, base, services)
    ).rejects.toThrow();
  }
  await writeFile(base.config, '{broken');
  await expect(executeFleet('health', {}, base, services)).rejects.toThrow();
});
