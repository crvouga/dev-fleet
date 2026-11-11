import { expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleet } from '../../../src/fleet-config';
import {
  envName,
  parseSecretsConfig,
  secretsProvider,
  type SecretName,
  type SecretsConfig,
} from '../../../src/secrets';
import { control, core, need } from './world';

/** Where a fleet keeps its secrets, and reading one of them. */
const { Given, When, Then } = core;

Given('a fleet whose secrets block is:', (world, block: string) => {
  world.secrets = JSON.parse(block) as SecretsConfig;
});

Given(
  'the environment variable {string} holds {string}',
  (world, name: string, value: string) => {
    // The environment of the scenario, never the one this test runs in.
    world.environment[name] = control(value);
  }
);

Given(
  'a fleet that keeps its secrets as files in a directory of its own',
  async (world) => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-secrets-'));
    world.defer(() => rm(directory, { recursive: true, force: true }));
    world.secretsDirectory = directory;
    world.secrets = { provider: 'file', directory };
  }
);

Given(
  'the file {string} in that directory holds {string}',
  async (world, name: string, content: string) => {
    await writeFile(
      join(need(world, world.secretsDirectory, 'a directory of secrets'), name),
      control(content)
    );
  }
);

When('the secret {string} is read', async (world, name: SecretName) => {
  const read = secretsProvider(need(world, world.secrets, 'a secrets block'), {
    env: world.environment,
    // A secrets tool is a command like any other: the scenario answers it.
    run: async (argv) => {
      const result = await world.commands.run(argv);
      return result.ok ? result.stdout : null;
    },
  });
  world.secret = await read(name);
});

Then('the secret read is {string}', (world, value: string) => {
  expect(world.secret).toBe(value);
});

Then('the secret is not available', (world) => {
  expect(world.secret).toBeNull();
});

Then(
  'the secret {string} is kept in the environment variable {string}',
  (_world, name: SecretName, variable: string) => {
    expect(envName(name)).toBe(variable);
  }
);

Then(
  'the fleet configuration in use keeps its secrets in {string}',
  (_world, provider: string) => {
    expect<string>(fleet.secrets.provider).toBe(provider);
  }
);

When(
  /^(?:the secrets block (.+)|no secrets block) is read$/,
  (world, block: string | null) => {
    const written: unknown = block === null ? undefined : JSON.parse(block);
    world.secretsBlock = { written, read: parseSecretsConfig(written) };
  }
);

Then(/^it is accepted as (.+)$/, (world, block: string) => {
  const { written, read } = need(world, world.secretsBlock, 'a secrets block');
  expect(written).toEqual(JSON.parse(block));
  expect<unknown>(read).toEqual(JSON.parse(block));
});

Then('the secrets block is rejected', (world) => {
  expect(need(world, world.secretsBlock, 'a secrets block').read).toBeNull();
});
