import { afterEach, expect, test } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { managerAgentProfiles } from '../../src/cli/fleet-sync-manager';
import { machineProviders as managerProviders } from '../../src/t3/providers';
import type { Runner } from '../../src/types';

const repo = resolve(import.meta.dir, '../..');
const roster = async () => [
  {
    tool: 'codex',
    email: 'a@example.com',
    prefix: 'codex-a@example.com',
    models: ['gpt-x'],
  },
];
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function home(settings?: unknown) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'manager-t3-')));
  directories.push(dir);
  if (settings !== undefined) {
    await mkdir(join(dir, 'userdata'), { recursive: true });
    await writeFile(
      join(dir, 'userdata/settings.json'),
      JSON.stringify(settings)
    );
  }
  return dir;
}
const instances = async (dir: string) =>
  JSON.parse(await readFile(join(dir, 'userdata/settings.json'), 'utf8'))
    .providerInstances as Record<string, unknown>;

test('a plan reports pending manager providers without writing', async () => {
  const dir = await home({ providerInstances: { antigravity: {} } });
  const check = await managerProviders('manager-mac', repo, false, {
    t3Home: dir,
    roster,
  });
  expect(check.status).toBe('warn');
  expect(check.summary).toBe('T3_PROVIDERS_PENDING');
  expect(Object.keys(await instances(dir))).toEqual(['antigravity']);
});

test('apply adds the declared worker providers, keeps others, then is a no-op', async () => {
  const dir = await home({ providerInstances: { antigravity: {} } });
  expect(
    (
      await managerProviders('manager-mac', repo, true, {
        t3Home: dir,
        roster,
      })
    ).status
  ).toBe('pass');
  const applied = await instances(dir);
  expect(Object.keys(applied).sort()).toEqual([
    'antigravity',
    'personal_codex_a_example_com',
    'personal_gateway_models',
    'personal_grok_proxy',
  ]);
  expect(applied['personal_codex_a_example_com']).toMatchObject({
    displayName: 'Codex a@example.com',
  });
  expect(JSON.stringify(applied)).toContain('manager-mac');
  const again = await managerProviders('manager-mac', repo, false, {
    t3Home: dir,
    roster,
  });
  expect(again.status).toBe('pass');
});

test('an unowned instance with a managed ID is reported, never overwritten', async () => {
  const dir = await home({
    providerInstances: { personal_grok_proxy: { driver: 'grok' } },
  });
  const check = await managerProviders('manager-mac', repo, true, {
    t3Home: dir,
    roster,
  });
  expect(check.status).toBe('fail');
  expect(check.summary).toBe('T3_PROVIDER_CONFLICT');
  expect(await instances(dir)).toEqual({
    personal_grok_proxy: { driver: 'grok' },
  });
});

const ok = { ok: true, stdout: '', stderr: '', reason: 'ok' } as never;
const failed = { ok: false, stdout: '', stderr: '', reason: 'exit' } as never;

test('the manager applies every proxy agent profile the workers get', async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    return ok;
  };
  const [check] = await managerAgentProfiles('manager-mac', repo, run);
  expect(check?.status).toBe('pass');
  const tools = calls.map((argv) => argv[argv.indexOf('--tool') + 1]);
  expect(tools).toEqual([
    'codex',
    'claude',
    'gemini',
    'opencode',
    'grok',
    'antigravity',
  ]);
  for (const argv of calls) {
    expect(argv).toContain('--yes');
    expect(argv[argv.indexOf('--profile') + 1]).toBe('proxy');
    expect(argv[argv.indexOf('--node') + 1]).toBe('manager-mac');
  }
});

test('a failed profile apply fails the manager and names the tool to fix', async () => {
  const run: Runner = async (argv) => (argv.includes('claude') ? failed : ok);
  const [check] = await managerAgentProfiles('manager-mac', repo, run);
  expect(check?.status).toBe('fail');
  expect(check?.summary).toBe('MANAGER_AGENT_PROFILES_FAILED');
  expect(check?.remedy?.action).toContain('--tool claude');
});
