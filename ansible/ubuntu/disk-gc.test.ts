import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gc = join(import.meta.dir, 'disk-gc.py');
const DAY = 24 * 3600;

function git(cwd: string, ...args: string[]) {
  const out = Bun.spawnSync(['git', '-c', 'safe.directory=*', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  expect(out.exitCode).toBe(0);
}

/** Sets every path's mtime to `ageDays` ago. */
function age(ageDays: number, ...paths: string[]) {
  const when = Date.now() / 1000 - ageDays * DAY;
  for (const path of paths) utimesSync(path, when, when);
}

/** A home directory holding one checkout with ignored and tracked output. */
function fixture(idleDays: number) {
  const home = mkdtempSync(join(tmpdir(), 'disk-gc-'));
  const repo = join(home, 'project');
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(repo, 'dist'), { recursive: true });
  mkdirSync(join(repo, '.cache', 'scratch'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.cache/\n');
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'x');
  writeFileSync(join(repo, '.cache', 'scratch', 'blob'), 'x');
  // dist is tracked here, so it is source, not build output.
  writeFileSync(join(repo, 'dist', 'keep.js'), 'x');
  writeFileSync(join(repo, 'src', 'main.ts'), 'x');
  git(repo, 'init', '--quiet');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'fixture');
  const proc = join(home, 'proc');
  mkdirSync(proc);
  age(
    idleDays,
    repo,
    join(repo, '.git', 'index'),
    join(repo, '.git', 'HEAD'),
    join(repo, '.git', 'logs', 'HEAD'),
    join(repo, 'node_modules'),
    join(repo, '.cache'),
    join(repo, 'src', 'main.ts')
  );
  return { home, repo, proc };
}

function run(home: string, proc: string, ...extra: string[]) {
  const out = Bun.spawnSync([
    'python3',
    '-I',
    '-B',
    gc,
    '--home',
    home,
    '--path',
    home,
    '--pressure-mib',
    '0',
    '--proc',
    proc,
    // Never prune the test machine's Docker or apt cache.
    '--home-only',
    ...extra,
  ]);
  expect(out.exitCode).toBe(0);
  return out.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string; dry_run?: boolean });
}

test('an idle checkout loses only ignored build output', () => {
  const { home, repo, proc } = fixture(30);
  run(home, proc);
  expect(existsSync(join(repo, 'node_modules'))).toBe(false);
  expect(existsSync(join(repo, '.cache'))).toBe(false);
  expect(existsSync(join(repo, 'dist', 'keep.js'))).toBe(true);
  expect(existsSync(join(repo, 'src', 'main.ts'))).toBe(true);
});

test('a recently used checkout is left alone', () => {
  const { home, repo, proc } = fixture(1);
  run(home, proc);
  expect(existsSync(join(repo, 'node_modules'))).toBe(true);
});

test('a recent uncommitted edit keeps an otherwise idle checkout', () => {
  const { home, repo, proc } = fixture(30);
  writeFileSync(join(repo, 'src', 'main.ts'), 'changed');
  run(home, proc);
  expect(existsSync(join(repo, 'node_modules'))).toBe(true);
});

test('a checkout a process is running in is left alone', () => {
  const { home, repo, proc } = fixture(30);
  mkdirSync(join(proc, '4242'));
  symlinkSync(join(repo, 'src'), join(proc, '4242', 'cwd'));
  run(home, proc);
  expect(existsSync(join(repo, 'node_modules'))).toBe(true);
});

test('a dry run reports without deleting', () => {
  const { home, repo, proc } = fixture(30);
  const events = run(home, proc, '--dry-run');
  expect(existsSync(join(repo, 'node_modules'))).toBe(true);
  expect(events.some((e) => e.event === 'removed' && e.dry_run === true)).toBe(
    true
  );
});

test('pressure shortens the idle window to hours', () => {
  const { home, repo, proc } = fixture(1);
  run(
    home,
    proc,
    '--pressure-mib',
    String(Number.MAX_SAFE_INTEGER),
    '--pressure-idle-hours',
    '12'
  );
  expect(existsSync(join(repo, 'node_modules'))).toBe(false);
  expect(existsSync(join(repo, 'src', 'main.ts'))).toBe(true);
});
