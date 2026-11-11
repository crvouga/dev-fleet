import { afterEach, expect, test } from 'bun:test';
import {
  mkdtemp,
  realpath,
  readFile,
  rm,
  writeFile,
  symlink,
  mkdir,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileT3, importT3 } from '../../src/t3/reconcile';
import { planT3 } from '../../src/t3/plan';
import { desired } from '../../src/t3/desired';
import { execute } from '../../src/cli/program';
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'personal-t3-')));
  directories.push(dir);
  return {
    dir,
    settings: join(dir, 'settings.json'),
    state: join(dir, 'personal-managed.json'),
  };
}
const proxy = {
  driver: 'codex',
  enabled: true,
  config: { binaryPath: '/repo/adapter', homePath: '/home/profile' },
};

test('plan is read-only; apply preserves unrelated settings/secrets; repeat is no-op', async () => {
  const files = await fixture();
  const unrelated = {
    connect: { token: 'never-report-me' },
    providerInstances: {
      other: {
        driver: 'claudeAgent',
        environment: [{ secret: { name: 'private' } }],
      },
    },
  };
  await writeFile(files.settings, JSON.stringify(unrelated));
  const preview = await reconcileT3(
    files,
    { personal: proxy },
    { apply: false }
  );
  expect(preview.changes).toEqual([{ id: 'personal', action: 'create' }]);
  expect(JSON.stringify(preview)).not.toContain('never-report-me');
  expect(await Bun.file(files.state).exists()).toBe(false);
  await reconcileT3(
    files,
    { personal: proxy },
    { apply: true, planHash: preview.planHash }
  );
  const applied = JSON.parse(await readFile(files.settings, 'utf8'));
  expect(applied.connect).toEqual(unrelated.connect);
  expect(applied.providerInstances.other).toEqual(
    unrelated.providerInstances.other
  );
  const before = await stat(files.settings);
  const again = await reconcileT3(files, { personal: proxy }, { apply: true });
  expect(again.changed).toBe(false);
  expect((await stat(files.settings)).mtimeMs).toBe(before.mtimeMs);
  if (process.platform !== 'win32')
    expect((await stat(files.settings)).mode & 0o777).toBe(0o600);
});

test('drift is reconciled and only previously owned instances are removed', async () => {
  const files = await fixture();
  await reconcileT3(
    files,
    { personal: proxy, retired: proxy },
    { apply: true }
  );
  const settings = JSON.parse(await readFile(files.settings, 'utf8'));
  settings.providerInstances.personal.enabled = false;
  settings.providerInstances.unrelated = { driver: 'codex' };
  await writeFile(files.settings, JSON.stringify(settings));
  const plan = await reconcileT3(files, { personal: proxy }, { apply: false });
  expect(plan.changes).toEqual([
    { id: 'personal', action: 'update' },
    { id: 'retired', action: 'delete' },
  ]);
  await reconcileT3(files, { personal: proxy }, { apply: true });
  await reconcileT3(files, {}, { apply: true });
  expect(
    JSON.parse(await readFile(files.settings, 'utf8')).providerInstances
  ).toEqual({ unrelated: { driver: 'codex' } });
});

test('collisions require explicit import; import and cleanup never expose secrets', async () => {
  const files = await fixture();
  await writeFile(
    files.settings,
    JSON.stringify({
      providerInstances: { personal: { ...proxy, secret: 'keep-private' } },
    })
  );
  expect((await planT3(files, { personal: proxy })).changes[0]?.action).toBe(
    'conflict'
  );
  await expect(
    reconcileT3(files, { personal: proxy }, { apply: true })
  ).rejects.toThrow('without ownership');
  const imported = await importT3(files, 'personal');
  expect(JSON.stringify(imported)).not.toContain('keep-private');
  expect(await readFile(files.state, 'utf8')).not.toContain('keep-private');
  await reconcileT3(files, { personal: proxy }, { apply: true });
});

test('stale plans, malformed state and symlink destinations fail before writing', async () => {
  const files = await fixture();
  const preview = await reconcileT3(
    files,
    { personal: proxy },
    { apply: false }
  );
  await writeFile(files.settings, '{}');
  await expect(
    reconcileT3(
      files,
      { personal: proxy },
      { apply: true, planHash: preview.planHash }
    )
  ).rejects.toThrow('stale');
  expect(await readFile(files.settings, 'utf8')).toBe('{}');
  await writeFile(files.state, '{bad');
  await expect(reconcileT3(files, {}, { apply: true })).rejects.toThrow(
    'Invalid'
  );
  await rm(files.state);
  await rm(files.settings);
  const target = join(files.dir, 'target.json');
  await writeFile(target, '{}');
  await symlink(target, files.settings);
  await expect(reconcileT3(files, {}, { apply: true })).rejects.toThrow(
    'symlinks'
  );
  expect(await readFile(target, 'utf8')).toBe('{}');
});

test('lock excludes concurrent writers and interrupted ownership intent is retryable', async () => {
  const files = await fixture();
  await mkdir(`${files.state}.lock`);
  await expect(reconcileT3(files, {}, { apply: true })).rejects.toThrow('lock');
  await rm(`${files.state}.lock`, { recursive: true });
  await writeFile(
    files.state,
    JSON.stringify({
      version: 1,
      target: files.settings,
      instances: ['personal'],
    })
  );
  await reconcileT3(files, { personal: proxy }, { apply: true });
  expect(
    (await reconcileT3(files, { personal: proxy }, { apply: false })).changed
  ).toBe(false);
});

const roster = async () => [
  {
    tool: 'claude',
    email: 'a@example.com',
    prefix: 'claude-a@example.com',
    models: ['m'],
  },
  {
    tool: 'opencode',
    email: 'a@example.com',
    prefix: 'antigravity-a@example.com',
    models: ['g'],
  },
];
const tracked = () =>
  readFile(new URL('../../agents/t3.json', import.meta.url), 'utf8');

test('fixed instances substitute paths safely and reject credential fields', async () => {
  const files = await fixture();
  const definition = join(files.dir, 'definition.json');
  const source = await tracked();
  await writeFile(definition, source);
  const rendered = await desired(
    definition,
    '/repo/with "quotes"',
    'test-node',
    async () => []
  );
  expect(Object.keys(rendered).sort()).toEqual([
    'personal_gateway_models',
    'personal_grok_proxy',
  ]);
  expect(JSON.stringify(rendered)).toContain('test-node');
  type Definition = {
    instances: Record<
      string,
      { driver: string; environment: { name: string; value: string }[] }
    >;
  };
  for (const mutate of [
    (d: Definition) =>
      (d.instances['personal_grok_proxy']!.environment[0]!.name = 'API_KEY'),
    (d: Definition) =>
      (d.instances['personal_grok_proxy']!.environment[1]!.value = 'xai-real'),
    (d: Definition) => (d.instances['personal_grok_proxy']!.driver = 'pi'),
  ]) {
    const invalid = JSON.parse(source) as Definition;
    mutate(invalid);
    await writeFile(definition, JSON.stringify(invalid));
    await expect(
      desired(definition, '/repo', 'node', async () => [])
    ).rejects.toThrow('Invalid');
  }
});

test('every account signed in on the proxy becomes a pinned provider', async () => {
  const files = await fixture();
  const definition = join(files.dir, 'definition.json');
  await writeFile(definition, await tracked());
  const rendered = await desired(definition, '/repo', 'node', roster);
  expect(rendered['personal_claude_a_example_com']).toEqual({
    driver: 'claudeAgent',
    displayName: 'Claude a@example.com',
    enabled: true,
    config: {
      binaryPath: '/repo/agents/claude-proxy',
      homePath: expect.stringContaining('/node/claude/account-a_example_com'),
    },
    environment: [
      { name: 'WS_AGENT_NODE', value: 'node', sensitive: false },
      { name: 'WS_AGENT_ACCOUNT', value: 'a@example.com', sensitive: false },
    ],
  });
  expect(rendered['personal_antigravity_a_example_com']).toMatchObject({
    driver: 'opencode',
    displayName: 'AntiGravity a@example.com',
  });
  // No account is ever named in tracked source.
  expect(await tracked()).not.toContain('@');
});

test('an unreadable roster fails instead of dropping providers', async () => {
  const files = await fixture();
  const definition = join(files.dir, 'definition.json');
  await writeFile(definition, await tracked());
  await expect(
    desired(definition, '/repo', 'node', async () => {
      throw new Error('proxy down');
    })
  ).rejects.toThrow('proxy down');
});

test('public T3 commands run offline against fixtures, including cleanup and drift status', async () => {
  const files = await fixture();
  const definition = join(files.dir, 'empty.json');
  await writeFile(definition, JSON.stringify({ version: 1, instances: {} }));
  const defaults = {
    workspace: files.dir,
    config: join(files.dir, 'roster.json'),
  };
  const args = ['--t3-home', files.dir, '--definition', definition, '--json'];
  expect(
    (await execute(['t3-apply', '--dry-run', ...args], defaults, 'test'))
      .exitCode
  ).toBe(0);
  expect(
    (await execute(['t3-apply', ...args], defaults, 'test')).exitCode
  ).toBe(0);
  expect(
    (await execute(['t3-status', ...args], defaults, 'test')).exitCode
  ).toBe(0);
  expect(
    (await execute(['t3-cleanup', ...args], defaults, 'test')).exitCode
  ).toBe(0);
});

test('relative configuration reads terminate without escaping symlink checks', async () => {
  const { read } = await import('../../src/t3/files');
  const content = await read('package.json');
  expect(content).not.toBeNull();
});
