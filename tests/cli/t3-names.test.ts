import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conformNames,
  conformT3Names,
  localAccounts,
  type Accounts,
} from '../../src/t3/names';
import { providerNames } from '../../src/t3/names-check';

const accounts: Accounts = async (driver, home) =>
  ({
    claudeAgent: home ? 'second@example.com' : 'first@example.com',
    codex: 'first@example.com',
  })[driver];
const proxy = { driver: 'claudeAgent', displayName: 'Claude CLI Proxy' };

let dir = '';
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 't3-names-')));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test('native instances are named after their own account, managed ones as the proxy', async () => {
  const next = await conformNames(
    {
      personal_claude_proxy: { ...proxy, displayName: 'Claude (CLI Proxy)' },
      claudeAgent: {
        driver: 'claudeAgent',
        displayName: 'Claude',
        enabled: true,
      },
      work: {
        driver: 'claudeAgent',
        displayName: 'my other claude',
        config: { homePath: '/other' },
      },
      antigravity: { driver: 'antigravity', displayName: 'Antigravity' },
      custom: { driver: 'pi', displayName: 'Pi thing' },
    },
    { personal_claude_proxy: 'Claude CLI Proxy' },
    accounts
  );
  expect(next).toEqual({
    personal_claude_proxy: proxy,
    claudeAgent: {
      driver: 'claudeAgent',
      displayName: 'Claude first@example.com',
      enabled: true,
    },
    work: {
      driver: 'claudeAgent',
      displayName: 'Claude second@example.com',
      config: { homePath: '/other' },
    },
    // No readable account: the provider name alone, never a guess.
    antigravity: { driver: 'antigravity', displayName: 'AntiGravity' },
    custom: { driver: 'pi', displayName: 'Pi thing' },
    codex: { driver: 'codex', displayName: 'Codex first@example.com' },
  });
});

test('a signed-in default login gains an entry once, never a duplicate name', async () => {
  const first = await conformNames({}, {}, accounts);
  expect(first).toEqual({
    claudeAgent: {
      driver: 'claudeAgent',
      displayName: 'Claude first@example.com',
    },
    codex: { driver: 'codex', displayName: 'Codex first@example.com' },
  });
  expect(await conformNames(first, {}, accounts)).toEqual(first);
  const second = { driver: 'claudeAgent', displayName: 'Claude' };
  expect(
    Object.keys(await conformNames({ claudeAgent_2: second }, {}, accounts))
  ).toEqual(['claudeAgent_2', 'codex']);
});

test('only display names are written, live settings are preserved, and a repeat is a no-op', async () => {
  const settings = join(dir, 'settings.json');
  await writeFile(
    settings,
    JSON.stringify({
      theme: 'dark',
      providerInstances: { codex: { driver: 'codex', displayName: 'Codex' } },
    })
  );
  expect(
    await conformT3Names(settings, {}, { apply: false, accounts })
  ).toEqual({ changed: true });
  expect(
    JSON.parse(await readFile(settings, 'utf8')).providerInstances.codex
      .displayName
  ).toBe('Codex');
  await conformT3Names(settings, {}, { apply: true, accounts });
  const written = JSON.parse(await readFile(settings, 'utf8'));
  expect(written.theme).toBe('dark');
  expect(written.providerInstances.codex).toEqual({
    driver: 'codex',
    displayName: 'Codex first@example.com',
  });
  expect(await conformT3Names(settings, {}, { apply: true, accounts })).toEqual(
    {
      changed: false,
    }
  );
});

test('account emails come from each client login record, never a token', async () => {
  await writeFile(
    join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } })
  );
  const claims = Buffer.from(
    JSON.stringify({ email: 'b@example.com' })
  ).toString('base64url');
  await writeFile(
    join(dir, 'auth.json'),
    JSON.stringify({ tokens: { id_token: `x.${claims}.y` } })
  );
  expect(await localAccounts('claudeAgent', dir)).toBe('a@example.com');
  expect(await localAccounts('codex', dir)).toBe('b@example.com');
  expect(await localAccounts('codex', join(dir, 'missing'))).toBeUndefined();
  expect(await localAccounts('antigravity', dir)).toBeUndefined();
});

test('the fleet check conforms an isolated T3 home', async () => {
  const repo = join(import.meta.dir, '../..');
  const options = { t3Home: dir, roster: async () => [] };
  await mkdir(join(dir, 'userdata'), { recursive: true });
  await writeFile(
    join(dir, 'userdata/settings.json'),
    JSON.stringify({
      providerInstances: { x: { driver: 'grok', displayName: 'g' } },
    })
  );
  expect((await providerNames('node', repo, false, options)).status).toBe(
    'warn'
  );
  expect((await providerNames('node', repo, true, options)).status).toBe(
    'pass'
  );
  const written = JSON.parse(
    await readFile(join(dir, 'userdata/settings.json'), 'utf8')
  );
  expect(written.providerInstances.x.displayName).toBe('Grok');
});
