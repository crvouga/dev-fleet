import { expect } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { lastProxyKeyPath, proxyKey } from '../../../src/agents/secrets';
import { steps } from '../../support/gherkin';
import { part, type AgentsWorld } from './world';

export const proxyKeys = steps<AgentsWorld>();
const { Given, When, Then } = proxyKeys;

const node = part((world) => {
  const state = {
    home: undefined as string | undefined,
    provider: (async () => null) as () => Promise<string | null>,
    presented: undefined as string | undefined,
  };
  world.defer(() =>
    state.home ? rm(state.home, { recursive: true, force: true }) : undefined
  );
  return state;
});

async function home(world: AgentsWorld): Promise<string> {
  const state = node(world);
  state.home ??= await mkdtemp(`${tmpdir()}/proxy-key-`);
  return state.home;
}

Given(
  'the secrets provider gives the proxy client key {string}',
  (world, key: string) => {
    node(world).provider = async () => key;
  }
);

Given('the secrets provider cannot answer', (world) => {
  node(world).provider = async () => {
    throw new Error('PRIVATE_SENTINEL');
  };
});

Given(
  'the node remembers the proxy client key {string}',
  async (world, key: string) => {
    const path = lastProxyKeyPath(await home(world));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${key}\n`);
  }
);

When('an agent launches', async (world) => {
  const path = lastProxyKeyPath(await home(world));
  await world.attempt(async () => {
    node(world).presented = await proxyKey({
      read: node(world).provider,
      path,
    });
  });
});

Then(
  'the launch presents the proxy client key {string}',
  (world, key: string) => {
    expect(node(world).presented).toBe(key);
  }
);

Then(
  'the node remembers the proxy client key {string} where only its user can read it',
  async (world, key: string) => {
    const path = lastProxyKeyPath(await home(world));
    expect((await readFile(path, 'utf8')).trim()).toBe(key);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  }
);
