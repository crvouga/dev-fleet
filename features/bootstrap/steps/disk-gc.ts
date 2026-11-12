import { expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

const gc = resolve(import.meta.dir, '../../../ansible/ubuntu/disk-gc.py');
const DAY = 24 * 3600;

interface Event {
  event: string;
  dry_run?: boolean;
  reclaimed_mib?: number;
}

const collector = part((world) => {
  // Resolved, as the working directory of a real process always is: on macOS
  // the temporary directory is reached through a link.
  const home = realpathSync(world.directory('disk-gc-'));
  const proc = join(home, 'proc');
  mkdirSync(proc);
  return {
    home,
    repo: join(home, 'project'),
    /** A stand-in for /proc: what each running process has as its directory. */
    proc,
    /** Top-level entries the checkout ignores, without the trailing slash. */
    ignored: [] as string[],
    files: [] as string[],
    options: [] as string[],
    events: [] as Event[],
    worktree: '',
    cache: '',
    mise: '',
  };
});

function git(cwd: string, ...args: string[]): void {
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

export const diskGc = steps<BootstrapWorld>();
const { Given, When, Then } = diskGc;

Given(
  'a home directory with one checkout that ignores:',
  (world, table: DataTable) => {
    const state = collector(world);
    mkdirSync(state.repo);
    writeFileSync(
      join(state.repo, '.gitignore'),
      table.list().join('\n') + '\n'
    );
    state.ignored = table.list().map((entry) => entry.replace(/\/$/, ''));
  }
);

Given(
  'the checkout holds these files, all committed except the ignored ones:',
  (world, table: DataTable) => {
    const state = collector(world);
    state.files = table.list();
    for (const file of state.files) {
      mkdirSync(dirname(join(state.repo, file)), { recursive: true });
      writeFileSync(join(state.repo, file), 'x');
    }
    git(state.repo, 'init', '--quiet');
    git(state.repo, 'add', '.');
    git(state.repo, 'commit', '--quiet', '-m', 'fixture');
  }
);

/** Last used: the checkout, what Git touches on every command, the ignored
 * directories and every tracked file all carry that time.
 */
Given(/^the checkout was last used (\d+) days? ago$/, (world, days: string) => {
  const { repo, ignored, files } = collector(world);
  const when = Date.now() / 1000 - Number(days) * DAY;
  const tracked = files.filter(
    (file) => !ignored.includes(file.split('/')[0]!)
  );
  for (const path of [
    repo,
    join(repo, '.git', 'index'),
    join(repo, '.git', 'HEAD'),
    join(repo, '.git', 'logs', 'HEAD'),
    ...ignored.map((entry) => join(repo, entry)),
    ...tracked.map((file) => join(repo, file)),
  ])
    utimesSync(path, when, when);
});

Given(
  '{string} was edited just now and not committed',
  (world, file: string) => {
    writeFileSync(join(collector(world).repo, file), 'changed');
  }
);

Given(
  'a process is running in {string} of the checkout',
  (world, directory: string) => {
    const { repo, proc } = collector(world);
    mkdirSync(join(proc, '4242'));
    symlinkSync(join(repo, directory), join(proc, '4242', 'cwd'));
  }
);

Given(
  'the disk is under pressure, where {int} hours without use is idle',
  (world, hours: number) => {
    collector(world).options.push(
      '--pressure-mib',
      String(Number.MAX_SAFE_INTEGER),
      '--pressure-idle-hours',
      String(hours)
    );
  }
);

Given(
  'the disk is short of inodes, where {int} hours without use is idle',
  (world, hours: number) => {
    // Every filesystem has fewer than 101% of its inodes free.
    collector(world).options.push(
      '--pressure-inode-percent',
      '101',
      '--pressure-idle-hours',
      String(hours)
    );
  }
);

When(/^the disk GC runs( as a dry run)?$/, (world, dry: string | undefined) =>
  runCollector(world, Boolean(dry))
);

When('the disk GC runs with these limits:', (world, table: DataTable) => {
  collector(world).options.push(...table.raw().flat());
  runCollector(world, false);
});

function runCollector(world: BootstrapWorld, dry: boolean): void {
  const state = collector(world);
  const out = Bun.spawnSync([
    'python3',
    '-I',
    '-B',
    gc,
    '--home',
    state.home,
    '--path',
    state.home,
    '--pressure-mib',
    '0',
    '--proc',
    state.proc,
    // Never prune the machine's own Docker or apt cache.
    '--home-only',
    ...state.options,
    ...(dry ? ['--dry-run'] : []),
  ]);
  expect(out.exitCode).toBe(0);
  state.events = out.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event);
}

Then('these are gone from the checkout:', (world, table: DataTable) => {
  for (const path of table.list())
    expect(`${path}: ${existsSync(join(collector(world).repo, path))}`).toBe(
      `${path}: false`
    );
});

Then('these are still in the checkout:', (world, table: DataTable) => {
  for (const path of table.list())
    expect(`${path}: ${existsSync(join(collector(world).repo, path))}`).toBe(
      `${path}: true`
    );
});

Then('it reports a removal marked as a dry run', (world) => {
  expect(
    collector(world).events.some(
      (event) => event.event === 'removed' && event.dry_run === true
    )
  ).toBe(true);
});

// ── Stores that only grow ───────────────────────────────────────────────

const MIB = 1024 * 1024;

Given('the checkout has a remote that holds its commits', (world) => {
  const { home, repo } = collector(world);
  const origin = join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  git(repo, 'fetch', '--quiet', 'origin');
});

Given(
  /^an agent worktree "([^"]+)" of the checkout under "([^"]+)" with (nothing unsaved|a commit no remote holds|an uncommitted edit|an untracked file|a process running in it)$/,
  (world, name: string, under: string, work: string) => {
    const state = collector(world);
    const worktree = join(state.home, under, name);
    mkdirSync(dirname(worktree), { recursive: true });
    git(state.repo, 'worktree', 'add', '--quiet', '-b', name, worktree);
    state.worktree = worktree;
    if (work === 'a commit no remote holds') {
      writeFileSync(join(worktree, 'src/main.ts'), 'fixed');
      git(worktree, 'commit', '--quiet', '-am', 'fix');
    } else if (work === 'an uncommitted edit')
      writeFileSync(join(worktree, 'src/main.ts'), 'half done');
    else if (work === 'an untracked file')
      writeFileSync(join(worktree, 'notes.md'), 'ideas');
    else if (work === 'a process running in it') {
      mkdirSync(join(state.proc, '4343'));
      symlinkSync(worktree, join(state.proc, '4343', 'cwd'));
    }
  }
);

/** Every file of the worktree and what Git touches for it carry that time,
 * so only what is in it can keep it. */
Given(/^the worktree was last used (\d+) days ago$/, (world, days: string) => {
  const { repo, worktree } = collector(world);
  const when = Date.now() / 1000 - Number(days) * DAY;
  const admin = join(repo, '.git', 'worktrees', basename(worktree));
  const paths = [
    join(admin, 'index'),
    join(admin, 'HEAD'),
    join(admin, 'logs', 'HEAD'),
  ];
  const walk = (directory: string): void => {
    paths.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else paths.push(join(directory, entry.name));
  };
  walk(worktree);
  for (const path of paths) if (existsSync(path)) utimesSync(path, when, when);
});

Then(/^the worktree is (removed|kept)$/, (world, verdict: string) => {
  const { repo, worktree } = collector(world);
  expect(existsSync(worktree)).toBe(verdict === 'kept');
  // The branch outlives its worktree.
  git(
    repo,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${basename(worktree)}`
  );
});

Given(
  'the cache {string} holds {int} files of {int} MiB, written an hour apart',
  (world, cache: string, count: number, size: number) => {
    const state = collector(world);
    state.cache = join(state.home, cache);
    mkdirSync(join(state.cache, 'packages'), { recursive: true });
    const now = Date.now() / 1000;
    for (let index = 0; index < count; index += 1) {
      const path = join(state.cache, 'packages', `entry-${index}`);
      writeFileSync(path, Buffer.alloc(size * MIB, 1));
      const when = now - (count - index) * 3600;
      utimesSync(path, when, when);
    }
  }
);

const cacheFiles = (cache: string): string[] =>
  readdirSync(join(cache, 'packages')).sort();

Then(
  'the cache {string} holds {int} MiB or less',
  (world, _cache: string, mib: number) => {
    const { cache } = collector(world);
    const total = cacheFiles(cache).reduce(
      (sum, name) => sum + statSync(join(cache, 'packages', name)).size,
      0
    );
    expect(total).toBeLessThanOrEqual(mib * MIB);
  }
);

Then('the newest file of the cache is still there', (world) => {
  expect(cacheFiles(collector(world).cache)).toContain('entry-5');
});

Then('the run reports at least {int} MiB reclaimed', (world, mib: number) => {
  const finished = collector(world).events.find(
    (event) => event.event === 'finished'
  );
  expect(finished?.reclaimed_mib).toBeGreaterThanOrEqual(mib);
});

Given(
  'the directory {string} holds these downloads, oldest first:',
  (world, directory: string, table: DataTable) => {
    const target = join(collector(world).home, directory);
    mkdirSync(target);
    const now = Date.now() / 1000;
    table.list().forEach((name, index, names) => {
      writeFileSync(join(target, name), name);
      const when = now - (names.length - index) * 3600;
      utimesSync(join(target, name), when, when);
    });
  }
);

Then(
  'the directory {string} holds exactly:',
  (world, directory: string, table: DataTable) => {
    expect(readdirSync(join(collector(world).home, directory)).sort()).toEqual(
      table.list().sort()
    );
  }
);

Given('a stand-in for mise that records how it is run', (world) => {
  const state = collector(world);
  state.mise = join(state.home, 'mise');
  writeFileSync(
    state.mise,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${state.mise}.log'\n`,
    { mode: 0o755 }
  );
});

When('the disk GC runs with the stand-in for mise', (world) => {
  const state = collector(world);
  state.options.push('--mise', state.mise);
  runCollector(world, false);
});

Then('the stand-in for mise was run with {string}', (world, args: string) => {
  expect(readFileSync(`${collector(world).mise}.log`, 'utf8')).toBe(
    `${args}\n`
  );
});
