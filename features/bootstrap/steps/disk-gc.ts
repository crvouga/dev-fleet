import { expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

const gc = resolve(import.meta.dir, '../../../ansible/ubuntu/disk-gc.py');
const DAY = 24 * 3600;

interface Event {
  event: string;
  dry_run?: boolean;
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

When(/^the disk GC runs( as a dry run)?$/, (world, dry: string | undefined) => {
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
});

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
