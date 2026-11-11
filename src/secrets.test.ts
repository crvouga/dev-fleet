import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envName,
  parseSecretsConfig,
  secretsProvider,
  type SecretCommand,
} from './secrets';
import { fleet } from './fleet-config';

test('env provider reads one variable per secret', async () => {
  expect(envName('proxy-client-key')).toBe('DEVFLEET_SECRET_PROXY_CLIENT_KEY');
  const get = secretsProvider(
    { provider: 'env' },
    { env: { DEVFLEET_SECRET_PROXY_CLIENT_KEY: ' value\n' } }
  );
  expect(await get('proxy-client-key')).toBe('value');
  expect(await get('monitoring-tunnel-token')).toBeNull();
});

test('file provider reads one private file per secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-secrets-'));
  try {
    await writeFile(join(directory, 'proxy-client-key'), 'from-file\n');
    const get = secretsProvider({ provider: 'file', directory });
    expect(await get('proxy-client-key')).toBe('from-file');
    expect(await get('monitoring-account-password')).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sops and vault providers ask their own tool and never pass a secret in argv', async () => {
  const calls: string[][] = [];
  const run: SecretCommand = async (argv) => {
    calls.push(argv);
    return argv[0] === 'vault' && argv.includes('missing') ? null : 'secret\n';
  };
  const sops = secretsProvider(
    { provider: 'sops', file: '/x/secrets.yaml' },
    { run }
  );
  expect(await sops('proxy-client-key')).toBe('secret');
  expect(calls[0]).toEqual([
    'sops',
    '--decrypt',
    '--extract',
    '["proxy-client-key"]',
    '/x/secrets.yaml',
  ]);
  const location = { path: 'team/prd', field: 'KEY' };
  const vault = secretsProvider(
    {
      provider: 'vault',
      address: 'https://vault.example.org',
      mount: 'secret',
      locations: {
        'proxy-client-key': location,
        'monitoring-account-password': location,
        'monitoring-tunnel-token': { path: 'missing', field: 'TOKEN' },
        'proxy-tunnel-token': location,
      },
    },
    { run }
  );
  expect(await vault('proxy-client-key')).toBe('secret');
  expect(calls[1]).toEqual([
    'vault',
    'kv',
    'get',
    '-address=https://vault.example.org',
    '-mount=secret',
    '-field=KEY',
    'team/prd',
  ]);
  expect(await vault('monitoring-tunnel-token')).toBeNull();
});

test('this fleet declares where every secret is kept', () => {
  expect(fleet.secrets.provider).toBe('vault');
});

test('an invalid secrets block is rejected, never guessed', () => {
  expect(parseSecretsConfig({ provider: 'env' })).toEqual({ provider: 'env' });
  expect(parseSecretsConfig({ provider: 'file' })).toEqual({
    provider: 'file',
  });
  for (const invalid of [
    undefined,
    { provider: 'keychain' },
    { provider: 'env', extra: 1 },
    { provider: 'sops' },
    {
      provider: 'vault',
      address: 'http://plain',
      mount: 'secret',
      locations: {},
    },
    {
      provider: 'vault',
      address: 'https://v.example.org',
      mount: 'secret',
      locations: {},
    },
  ])
    expect(parseSecretsConfig(invalid)).toBeNull();
});
