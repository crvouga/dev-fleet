import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = readFileSync(
  resolve(import.meta.dir, '../bootstrap/fleet-manager-run.sh'),
  'utf8'
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const IDENTITY = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** A manager's home with nothing on it but Git: no dev-fleet clone, no mise.
 * `mise` and `bash` are stand-ins that record how they were called, so the
 * script runs to its last line without installing a toolchain. `origin` is
 * the fleet's source repository.
 */
function manager() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-manager-run-')));
  roots.push(home);
  const bin = join(home, '.local/bin');
  const calls = join(home, 'calls');
  mkdirSync(bin, { recursive: true });
  writeFileSync(calls, '');
  for (const name of ['mise', 'bash']) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> ${calls}\n`
    );
    chmodSync(join(bin, name), 0o755);
  }
  const env = { ...IDENTITY, HOME: home, PATH: '/usr/bin:/bin' };
  const git = (cwd: string, ...args: string[]): string => {
    const result = Bun.spawnSync(['git', '-C', cwd, ...args], { env });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const origin = join(home, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '--quiet', '--initial-branch', 'main');
  const commit = (text: string): string => {
    writeFileSync(join(origin, 'file'), text);
    git(origin, 'add', 'file');
    git(origin, 'commit', '--quiet', '--message', text);
    return git(origin, 'rev-parse', 'HEAD');
  };
  const fleet = join(home, '.local/share/personal/fleet');
  return {
    home,
    origin,
    commit,
    git,
    /** The manager's own copy of the source repository, as fleet-sync makes it. */
    cache: join(fleet, 'manager/source'),
    runs: join(fleet, 'manager-runs'),
    calls: () => readFileSync(calls, 'utf8'),
    run: (revision: string, extra: Record<string, string> = {}) => {
      const result = Bun.spawnSync(
        ['/bin/sh', '-c', SCRIPT, 'fleet-manager-run', revision, '--json'],
        { env: { ...env, ...extra } }
      );
      return { code: result.exitCode, stderr: result.stderr.toString() };
    },
  };
}

test('a manager with no clone of dev-fleet runs the revision from its own copy of the source repository', () => {
  const node = manager();
  const first = node.commit('first');
  mkdirSync(join(node.cache, '..'), { recursive: true });
  node.git(
    node.home,
    'clone',
    '--quiet',
    '--no-checkout',
    node.origin,
    node.cache
  );
  // Started by fleet-sync, which names the repository it prepared.
  expect(node.run(first, { DEVFLEET_REPO: node.cache }).code).toBe(0);
  const checkout = join(node.runs, first);
  expect(node.git(checkout, 'rev-parse', 'HEAD')).toBe(first);
  expect(readFileSync(join(checkout, 'file'), 'utf8')).toBe('first');
  // The toolchain bootstrap installs mise where there is none, then the CLI
  // runs from the checkout.
  expect(node.calls()).toContain('bash bootstrap/bootstrap.sh --tools-only');
  expect(node.calls().trimEnd().split('\n').at(-1)).toBe(
    `mise exec --locked bun -- bun src/cli/cli.ts fleet-sync --revision ${first} --json`
  );
  // Handed off from a worker: nothing names a repository, and the revision is
  // newer than anything this manager has fetched.
  const second = node.commit('second');
  expect(node.run(second).code).toBe(0);
  expect(node.git(join(node.runs, second), 'rev-parse', 'HEAD')).toBe(second);
  // A checkout that is already there is reused.
  const before = node.calls();
  expect(node.run(second).code).toBe(0);
  expect(node.calls().slice(before.length)).not.toContain('bootstrap.sh');
});

test('without any source on the manager the hand-off says how to get one and changes nothing', () => {
  const node = manager();
  const revision = node.commit('first');
  const result = node.run(revision);
  expect(result.code).toBe(3);
  expect(result.stderr).toContain('run fleet-sync once on the manager itself');
  expect(existsSync(node.runs)).toBe(false);
  expect(node.run('main').code).toBe(2);
});

test('older run checkouts are pruned, also the ones an earlier clone made', () => {
  const node = manager();
  const revision = node.commit('first');
  node.git(
    node.home,
    'clone',
    '--quiet',
    '--no-checkout',
    node.origin,
    node.cache
  );
  // Left behind by runs from a clone that is gone: not this repository's.
  const stale = ['1', '2', '3', '4'].map((digit) => digit.repeat(40));
  for (const [index, name] of stale.entries()) {
    mkdirSync(join(node.runs, name, 'node_modules'), { recursive: true });
    const then = new Date(Date.UTC(2020, 0, 1 + index));
    utimesSync(join(node.runs, name), then, then);
  }
  expect(node.run(revision).code).toBe(0);
  const kept = readdirSync(node.runs).filter((name) =>
    /^[a-f0-9]{40}$/.test(name)
  );
  // This run and the two most recent others.
  expect(kept.sort()).toEqual([revision, stale[2]!, stale[3]!].sort());
});
