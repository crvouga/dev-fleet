import { expect } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import {
  ROOT,
  fleetSync,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

const SCRIPT = readFileSync(
  resolve(ROOT, 'bootstrap/fleet-manager-run.sh'),
  'utf8'
);
const IDENTITY = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** A manager's home in a temporary directory. `origin` is the fleet's source
 * repository; the real run script runs against it with the real Git.
 */
interface Manager {
  home: string;
  origin: string;
  /** The manager's own copy of the source repository, as fleet-sync makes it. */
  cache: string;
  runs: string;
  env: Record<string, string>;
  /** The SHA of each commit, by its message. */
  commits: Map<string, string>;
  /** How the stand-ins were called, one line for each call. */
  calls: () => string;
  /** How much of `calls` there was before the run under test. */
  before: number;
  result: { code: number; stderr: string } | undefined;
}
const managers = new WeakMap<FleetSyncWorld, Manager>();

function manager(world: FleetSyncWorld): Manager {
  const found = managers.get(world);
  if (!found) throw new Error("No manager's home in this scenario.");
  return found;
}

function git(node: Manager, cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { env: node.env });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function sha(node: Manager, message: string): string {
  const commit = node.commits.get(message);
  if (!commit) throw new Error(`No commit "${message}" in this scenario.`);
  return commit;
}

function start(
  node: Manager,
  revision: string,
  flags: string,
  extra: Record<string, string> = {}
): { code: number; stderr: string } {
  const result = Bun.spawnSync(
    [
      '/bin/sh',
      '-c',
      SCRIPT,
      'fleet-manager-run',
      revision,
      ...flags.split(' '),
    ],
    { env: { ...node.env, ...extra } }
  );
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

Given(
  /^a manager's home with nothing on it but Git, where "mise" and "bash" only record how they are called$/,
  (world) => {
    // No dev-fleet clone and no mise: the stand-ins let the script run to its
    // last line without installing a toolchain.
    const home = temporary(world, 'fleet-manager-run-');
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
    const fleet = join(home, '.local/share/personal/fleet');
    const node: Manager = {
      home,
      origin: join(home, 'origin'),
      cache: join(fleet, 'manager/source'),
      runs: join(fleet, 'manager-runs'),
      env: { ...IDENTITY, HOME: home, PATH: '/usr/bin:/bin' },
      commits: new Map(),
      calls: () => readFileSync(calls, 'utf8'),
      before: 0,
      result: undefined,
    };
    mkdirSync(node.origin);
    git(node, node.origin, 'init', '--quiet', '--initial-branch', 'main');
    managers.set(world, node);
  }
);

Given(
  /^the fleet's source repository (?:holds|gains) the commit "([^"]*)"$/,
  (world, message: string) => {
    const node = manager(world);
    // The commit's one file holds its message.
    writeFileSync(join(node.origin, 'file'), message);
    git(node, node.origin, 'add', 'file');
    git(node, node.origin, 'commit', '--quiet', '--message', message);
    node.commits.set(message, git(node, node.origin, 'rev-parse', 'HEAD'));
  }
);

Given('the manager has its own copy of the source repository', (world) => {
  const node = manager(world);
  git(
    node,
    node.home,
    'clone',
    '--quiet',
    '--no-checkout',
    node.origin,
    node.cache
  );
});

Given(
  'these run checkouts, each with its {string}, were left behind by an earlier clone:',
  (world, directory: string, table: DataTable) => {
    const node = manager(world);
    for (const row of table.hashes()) {
      const checkout = join(node.runs, row['name']!);
      mkdirSync(join(checkout, directory), { recursive: true });
      const then = new Date(`${row['last used']}T00:00:00Z`);
      utimesSync(checkout, then, then);
    }
  }
);

Given(
  'the run script has already run for the commit {string} with {string}',
  (world, message: string, flags: string) => {
    const node = manager(world);
    expect(start(node, sha(node, message), flags).code).toBe(0);
  }
);

function run(
  world: FleetSyncWorld,
  revision: (node: Manager) => string,
  flags: string,
  extra: (node: Manager) => Record<string, string> = () => ({})
): void {
  const node = manager(world);
  node.before = node.calls().length;
  node.result = start(node, revision(node), flags, extra(node));
}

When(
  /^the run script is started for the commit "([^"]*)" with "([^"]*)"$/,
  (world, message: string, flags: string) => {
    run(world, (node) => sha(node, message), flags);
  }
);

When(
  'the run script is started for the commit {string} with {string}, from the repository fleet-sync prepared',
  (world, message: string, flags: string) => {
    // fleet-sync names the repository it prepared: the manager's own copy.
    run(
      world,
      (node) => sha(node, message),
      flags,
      (node) => ({ DEVFLEET_REPO: node.cache })
    );
  }
);

When(
  'the run script is started for the revision {string} with {string}',
  (world, revision: string, flags: string) => {
    run(world, () => revision, flags);
  }
);

Then('the run script exits with {int}', (world, code: number) => {
  expect(manager(world).result?.code).toBe(code);
});

Then('the run script says {string}', (world, text: string) => {
  expect(manager(world).result?.stderr).toContain(text);
});

Then('there is no directory of run checkouts', (world) => {
  expect(existsSync(manager(world).runs)).toBe(false);
});

Then(
  'the run checkout of the commit {string} is at that commit',
  (world, message: string) => {
    const node = manager(world);
    const commit = sha(node, message);
    expect(git(node, join(node.runs, commit), 'rev-parse', 'HEAD')).toBe(
      commit
    );
  }
);

Then(
  'the file {string} in the run checkout of the commit {string} holds {string}',
  (world, file: string, message: string, content: string) => {
    const node = manager(world);
    expect(
      readFileSync(join(node.runs, sha(node, message), file), 'utf8')
    ).toBe(content);
  }
);

Then('the run script ran {string}', (world, line: string) => {
  expect(manager(world).calls()).toContain(line);
});

Then(
  /^the last thing the run script ran is "([^"]*)", where \{(\w+)\} is that commit$/,
  (world, line: string, message: string) => {
    const node = manager(world);
    expect(node.calls().trimEnd().split('\n').at(-1)).toBe(
      line.replace(`{${message}}`, sha(node, message))
    );
  }
);

Then(
  'this time the run script ran nothing that names {string}',
  (world, text: string) => {
    const node = manager(world);
    expect(node.calls().slice(node.before)).not.toContain(text);
  }
);

Then(
  'the run checkouts that remain are that of the commit {string} and:',
  (world, message: string, table: DataTable) => {
    const node = manager(world);
    const kept = readdirSync(node.runs).filter((name) =>
      /^[a-f0-9]{40}$/.test(name)
    );
    expect(kept.sort()).toEqual([sha(node, message), ...table.list()].sort());
  }
);
