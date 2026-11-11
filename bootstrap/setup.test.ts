import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishGlobalConfig } from './global-config';
import { appendOnce, miseDataDir } from './shell-path';
import { dockerChecks, toolChecks } from './doctor';
import { awsWindowsArtifact } from './native-aws';

test('global config publishes lock sidecars, is repeatable and refuses foreign configs', () => {
  const temp = mkdtempSync(join(tmpdir(), 'toolchain-'));
  const source = join(temp, 'source');
  const target = join(temp, 'global');
  mkdirSync(join(source, '.mise/locks'), { recursive: true });
  writeFileSync(join(source, 'mise.toml'), '[tools]\nbun = "1.4.4"\n');
  writeFileSync(join(source, 'mise.lock'), 'fixture lock');
  writeFileSync(join(source, '.mise/locks/npm.json'), 'fixture graph');
  try {
    publishGlobalConfig(target, source);
    const managedPaths = [
      'config.toml',
      'mise.lock',
      '.mise/locks/npm.json',
    ].map((path) => join(target, path));
    for (const path of managedPaths) utimesSync(path, 1000, 1000);
    publishGlobalConfig(target, source);
    for (const path of managedPaths)
      expect(statSync(path).mtimeMs).toBe(1_000_000);
    expect(readFileSync(join(target, 'mise.lock'), 'utf8')).toBe(
      'fixture lock'
    );
    expect(readFileSync(join(target, '.mise/locks/npm.json'), 'utf8')).toBe(
      'fixture graph'
    );
    writeFileSync(join(target, 'config.toml'), '# my config\n');
    expect(() => publishGlobalConfig(target, source)).toThrow(
      'Nothing was overwritten'
    );
    expect(readFileSync(join(target, 'config.toml'), 'utf8')).toBe(
      '# my config\n'
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('shell PATH setup preserves existing content and does not duplicate itself', () => {
  const temp = mkdtempSync(join(tmpdir(), 'toolchain-shell-'));
  try {
    const path = join(temp, 'profile');
    writeFileSync(path, '# user config\n');
    appendOnce(path, '# managed\nexport PATH=example');
    const first = readFileSync(path, 'utf8');
    appendOnce(path, '# managed\nexport PATH=example');
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(first).toStartWith('# user config\n');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('doctor fails a shadowed/wrong tool version and distinguishes optional Docker', () => {
  const checks = toolChecks(
    { node: '22.22.3', bun: '1.4.4', atlas: { version: '1.3.0', lazy: true } },
    (args) => ({ ok: true, output: args[0] === 'node' ? 'v20.0.0' : '1.4.4' })
  );
  expect(checks.find((check) => check.id === 'node')?.status).toBe('fail');
  expect(checks.find((check) => check.id === 'bun')?.status).toBe('pass');
  expect(checks.find((check) => check.id === 'atlas')).toBeUndefined();
  const unavailable = () => ({ ok: false, output: '' });
  expect(
    dockerChecks(false, unavailable).every((check) => check.status === 'warn')
  ).toBe(true);
  expect(
    dockerChecks(true, unavailable).every((check) => check.status === 'fail')
  ).toBe(true);
});

test('doctor skips a tool with no artifact for this platform, but not native Windows AWS', () => {
  const tools = {
    'http:grok': { version: '1.0.77', os: ['linux', 'macos'] },
    aws: { version: '2.39.2', os: ['linux', 'macos'] },
  };
  const ids = (platform: string) =>
    toolChecks(tools, () => ({ ok: false, output: '' }), platform)
      .map((check) => check.id)
      .filter((id) => id in tools);
  expect(ids('win32')).toEqual(['aws']);
  expect(ids('linux')).toEqual(['http:grok', 'aws']);
  expect(ids('darwin')).toEqual(['http:grok', 'aws']);
});

test('mise data location follows native Windows and XDG overrides', () => {
  expect(
    miseDataDir('win32', { LOCALAPPDATA: '/windows/local' }, '/user')
  ).toBe(join('/windows/local', 'mise'));
  expect(miseDataDir('linux', {}, '/user')).toBe(
    join('/user', '.local', 'share', 'mise')
  );
  expect(miseDataDir('win32', { MISE_DATA_DIR: '/custom' }, '/user')).toBe(
    '/custom'
  );
  expect(miseDataDir('darwin', { XDG_DATA_HOME: '/xdg' }, '/user')).toBe(
    join('/xdg', 'mise')
  );
});

test('version checks accept sentence punctuation but reject a longer version', () => {
  const result = (output: string) =>
    toolChecks({ copilot: '1.0.105' }, () => ({ ok: true, output }))[0]?.status;
  expect(result('GitHub Copilot CLI 1.0.105.')).toBe('pass');
  expect(result('GitHub Copilot CLI 1.0.1050')).toBe('fail');
  expect(result('GitHub Copilot CLI 1.0.105.1')).toBe('fail');
});

test('every base tool has locked artifacts for every supported OS/architecture', () => {
  const root = join(import.meta.dirname, '..');
  const config = Bun.TOML.parse(
    readFileSync(join(root, 'mise.toml'), 'utf8')
  ) as {
    settings: { lockfile_platforms: string[] };
    tools: Record<
      string,
      string | { version: string; lazy?: boolean; os?: string[] }
    >;
  };
  const lock = Bun.TOML.parse(
    readFileSync(join(root, 'mise.lock'), 'utf8')
  ) as {
    tools: Record<string, Array<Record<string, unknown>>>;
  };
  for (const [name, spec] of Object.entries(config.tools)) {
    if (typeof spec !== 'string' && spec.lazy) continue;
    const row = lock.tools[name]?.find(
      (entry) =>
        entry['version'] === (typeof spec === 'string' ? spec : spec.version)
    );
    expect(row, name).toBeDefined();
    if (row?.['aube']) {
      const graph = row['aube'] as { path: string; digest: string };
      expect(graph.digest).toStartWith('sha256:');
      expect(
        readFileSync(join(root, graph.path, 'aube-lock.yaml'), 'utf8')
      ).toContain('integrity:');
    } else if (name === 'rust') {
      expect(row?.['backend']).toBe('core:rust');
      expect(row?.['version']).toMatch(/^\d+\.\d+\.\d+$/);
    } else
      for (const platform of config.settings.lockfile_platforms) {
        // A tool restricted to some operating systems is never installed elsewhere.
        const os = typeof spec === 'string' ? undefined : spec.os;
        if (os && !os.includes(platform.split('-')[0]!)) continue;
        if (name === 'aws' && platform === 'windows-x64') {
          const artifact = awsWindowsArtifact(
            Bun.TOML.parse(
              readFileSync(join(root, 'mise.toml'), 'utf8')
            ) as Parameters<typeof awsWindowsArtifact>[0]
          );
          expect(artifact.version).toBe(
            typeof spec === 'string' ? spec : spec.version
          );
          expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
          continue;
        }
        const artifact = row?.[`platforms.${platform}`] as
          { checksum?: string } | undefined;
        expect(artifact?.checksum, `${name} ${platform}`).toStartWith(
          'sha256:'
        );
      }
  }
});

test('a global config published under an earlier owner name is still managed', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { assertManagedConfig } = await import('./global-config');
  const dir = mkdtempSync(join(tmpdir(), 'dev-fleet-mise-'));
  try {
    writeFileSync(
      join(dir, 'config.toml'),
      '# Managed by another/name scripts/dev/setup.ts\n[tools]\n'
    );
    expect(() => assertManagedConfig(dir)).not.toThrow();
    writeFileSync(join(dir, 'config.toml'), '[tools]\nnode = "22"\n');
    expect(() => assertManagedConfig(dir)).toThrow(
      'Existing mise configuration'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the published global config trusts agent worktree roots and keeps local trust entries', async () => {
  const { AGENT_WORKTREE_ROOTS, withTrustedPaths } =
    await import('./global-config');
  const temp = mkdtempSync(join(tmpdir(), 'toolchain-trust-'));
  const source = join(temp, 'source');
  const target = join(temp, 'global');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'mise.toml'),
    '[settings]\nlockfile = true\n\n[tools]\nbun = "1.4.4"\n'
  );
  writeFileSync(join(source, 'mise.lock'), 'fixture lock');
  const settings = () =>
    (
      Bun.TOML.parse(readFileSync(join(target, 'config.toml'), 'utf8')) as {
        settings: { trusted_config_paths: string[]; lockfile: boolean };
      }
    ).settings;
  try {
    publishGlobalConfig(target, source);
    expect(settings().trusted_config_paths).toEqual(AGENT_WORKTREE_ROOTS);
    expect(settings().lockfile).toBe(true);
    // What `mise settings add trusted_config_paths` writes must survive.
    const path = join(target, 'config.toml');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        /trusted_config_paths = \[/,
        'trusted_config_paths = ["/srv/local", '
      )
    );
    publishGlobalConfig(target, source);
    expect(settings().trusted_config_paths).toEqual([
      ...AGENT_WORKTREE_ROOTS,
      '/srv/local',
    ]);
    utimesSync(path, 1000, 1000);
    publishGlobalConfig(target, source);
    expect(statSync(path).mtimeMs).toBe(1_000_000);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  expect(withTrustedPaths('[tools]\n', ['~/a'])).toBe(
    '[tools]\n\n[settings]\ntrusted_config_paths = ["~/a"]\n'
  );
  expect(() =>
    withTrustedPaths('[settings]\ntrusted_config_paths = []\n', ['~/a'])
  ).toThrow('global config');
});

test('the repository mise.toml leaves trusted_config_paths to the global config', () => {
  // mise warns and ignores it in a project config.
  const config = Bun.TOML.parse(
    readFileSync(join(import.meta.dirname, '../mise.toml'), 'utf8')
  ) as { settings?: Record<string, unknown> };
  expect(config.settings?.['trusted_config_paths']).toBeUndefined();
});

test('doctor fails when an agent worktree root is not trusted', async () => {
  const { worktreeTrustCheck } = await import('./doctor');
  const { AGENT_WORKTREE_ROOTS } = await import('./global-config');
  const expanded = AGENT_WORKTREE_ROOTS.map((root) =>
    root.replace(/^~/, '/home/dev')
  );
  const answer =
    (output: string, ok = true) =>
    () => ({ ok, output });
  expect(
    worktreeTrustCheck(answer(JSON.stringify(expanded)), '/home/dev').status
  ).toBe('pass');
  expect(
    worktreeTrustCheck(
      answer(JSON.stringify(AGENT_WORKTREE_ROOTS)),
      '/home/dev'
    ).status
  ).toBe('pass');
  expect(worktreeTrustCheck(answer('[]'), '/home/dev').status).toBe('fail');
  expect(worktreeTrustCheck(answer('', false), '/home/dev').status).toBe(
    'fail'
  );
});
