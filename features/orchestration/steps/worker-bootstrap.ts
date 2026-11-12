import { expect } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fleet } from '../../../src/fleet-config';
import {
  bootstrapRemote,
  prepareBootstrap,
} from '../../../src/remote-bootstrap';
import { runCommand } from '../../../src/runner';
import type { CommandResult, Runner } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  need,
  orchestration,
  sessions,
  type OrchestrationWorld,
} from '../support/world';

const { Given, When, Then } = orchestration;

// ── Bootstrapping over SSH ───────────────────────────────────────────────

Given('a bootstrap payload of:', (world, table: DataTable) => {
  const { revision, digest, bundle } = table.rowsHash();
  world.bootstrap.payload = {
    revision: need(revision, 'a revision'),
    digest: need(digest, 'a digest'),
    bundle: need(bundle, 'a bundle'),
    script: '',
  };
});

Given('the bootstrap script of the payload is:', (world, script: string) => {
  need(world.bootstrap.payload, 'a bootstrap payload').script = script;
});

/** The SSH sessions of a bootstrap are answered in the order they are opened:
 * first the question whether the worker holds the revision, then the
 * bootstrap itself.
 */
function nextSession(world: OrchestrationWorld, answer: CommandResult): void {
  if (world.bootstrap.sessions.length === 0)
    world.commands.answer(
      () => true,
      () => world.bootstrap.sessions.shift() ?? failed()
    );
  world.bootstrap.sessions.push(answer);
}

Given(
  /^the worker answers that it (holds|does not hold) the revision$/,
  (world, held: string) => {
    nextSession(world, held === 'holds' ? succeeded('ready') : failed());
  }
);

Given(
  /^the bootstrap on the worker (succeeds|fails), printing:$/,
  (world, outcome: string, output: string) => {
    nextSession(world, {
      ...succeeded(output),
      ok: outcome === 'succeeds',
    });
  }
);

/** Time as the manager sees it during a bootstrap: a pause takes none, and
 * is added to the clock and to what the scenario can read back.
 */
interface Waiting {
  paused: number[];
  progress: string[];
  at: number;
}
const waiting = new WeakMap<OrchestrationWorld, Waiting>();
function waits(world: OrchestrationWorld): Waiting {
  let found = waiting.get(world);
  if (!found) {
    found = {
      paused: [],
      progress: [],
      at: Date.parse('2026-11-01T10:00:00Z'),
    };
    waiting.set(world, found);
  }
  return found;
}

When('the worker is bootstrapped', async (world) => {
  const time = waits(world);
  const report = await bootstrapRemote(
    need(world.nodes[0], 'a worker'),
    need(world.bootstrap.payload, 'a bootstrap payload'),
    world.run,
    {
      clock: {
        pause: (ms) => {
          time.paused.push(ms);
          time.at += ms;
          return Promise.resolve();
        },
        now: () => time.at,
      },
      progress: (line) => time.progress.push(line),
    }
  );
  world.checks = report.checks;
  world.outcome = report;
});

// ── A lost session, and an operation that is still running ───────────────

/** What the worker's operation probe prints. */
function operation(
  world: OrchestrationWorld,
  record: {
    held: boolean;
    alive: boolean;
    revision?: string;
    phase?: string;
    finished?: boolean;
    result?: string;
  }
): CommandResult {
  const started = Math.round(waits(world).at / 1000) - 600;
  const op = record.revision
    ? JSON.stringify({
        version: 1,
        pid: 4242,
        revision: record.revision,
        node: 'devbox',
        started,
        phase: record.phase ?? 'lock',
        ...(record.finished ? { finished: started + 900, exit: 0 } : {}),
      })
    : '';
  return succeeded(
    [
      `held=${record.held ? 'yes' : 'no'}`,
      `alive=${record.alive ? 'yes' : 'no'}`,
      `operation=${op}`,
      `result=${record.result ?? ''}`,
      '',
    ].join('\n')
  );
}

Given(
  'the worker says the operation of the revision {string} is still running, in the phase {string}',
  (world, revision: string, phase: string) => {
    nextSession(
      world,
      operation(world, { held: true, alive: true, revision, phase })
    );
  }
);

Given(
  'the worker says the operation of the revision {string} has finished, with the result:',
  (world, revision: string, result: string) => {
    nextSession(
      world,
      operation(world, {
        held: false,
        alive: false,
        revision,
        phase: 'finished',
        finished: true,
        result: JSON.stringify(JSON.parse(result)),
      })
    );
  }
);

Given(
  'the worker says something else holds its lock, and its last operation of the revision {string} has finished',
  (world, revision: string) => {
    nextSession(
      world,
      operation(world, {
        held: true,
        alive: false,
        revision,
        phase: 'finished',
        finished: true,
      })
    );
  }
);

Given('the worker says no operation runs on it', (world) => {
  nextSession(world, operation(world, { held: false, alive: false }));
});

Given(
  /^the (?:bootstrap )?session (?:is lost|cannot be opened), printing "([^"]*)"$/,
  (world, message: string) => {
    nextSession(world, failed(message));
  }
);

Then(
  'the manager paused for {int} seconds in all',
  (world, seconds: number) => {
    expect(waits(world).paused.reduce((sum, ms) => sum + ms, 0)).toBe(
      seconds * 1000
    );
  }
);

Then('while it followed, the manager showed:', (world, table: DataTable) => {
  expect(waits(world).progress).toEqual(table.list());
});

/** Every session after the one that asked what the worker holds. */
function bootstraps(world: OrchestrationWorld) {
  const after = sessions(world).slice(1);
  expect(after.length).toBeGreaterThan(0);
  return after;
}

Given(
  /^the sync (keeps running agent turns|restarts a busy T3 \(--restart-busy\))$/,
  (world, request: string) => {
    need(world.bootstrap.payload, 'a bootstrap payload').restartBusy =
      request.startsWith('restarts');
  }
);

Then(
  "the bootstrap passed {string} as how the worker's T3 restarts",
  (world, mode: string) => {
    expect(bootstraps(world).length).toBeGreaterThan(0);
    for (const { command } of bootstraps(world))
      expect(command.at(-1)!.endsWith(` '${mode}'`)).toBe(true);
  }
);

Then('the bootstrap ran in {string} mode', (world, mode: string) => {
  for (const { command } of bootstraps(world))
    expect(command.at(-1)).toContain(`'${mode}'`);
});

/** The bootstrap's input: a line with the configuration, then the bundle. */
function fed(world: OrchestrationWorld): { config: string; bundle: string }[] {
  return bootstraps(world).map(({ options }) => {
    const input = String(options?.input ?? '');
    const newline = input.indexOf('\n');
    expect(newline).toBeGreaterThanOrEqual(0);
    return {
      config: Buffer.from(input.slice(0, newline), 'base64').toString(),
      bundle: input.slice(newline + 1),
    };
  });
}

Then('the bootstrap was fed the bundle {string}', (world, bundle: string) => {
  for (const input of fed(world)) expect(input.bundle).toBe(bundle);
});

Then('the bootstrap was fed no bundle', (world) => {
  for (const input of fed(world)) expect(input.bundle).toBe('');
});

Then(
  'the bootstrap was fed, before anything else, the fleet configuration:',
  (world, config: string) => {
    for (const input of fed(world)) expect(input.config).toBe(config);
  }
);

Given(
  'the payload carries the fleet configuration:',
  (world, config: string) => {
    need(world.bootstrap.payload, 'a bootstrap payload').config = config;
  }
);

// ── The bundle ───────────────────────────────────────────────────────────

const git = (cwd: string, ...args: string[]): Promise<CommandResult> =>
  runCommand(
    ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    { cwd }
  );

/** For setting a situation up: a Git command that must work. */
async function must(cwd: string, ...args: string[]): Promise<string> {
  const result = await git(cwd, ...args);
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Real Git, but never the network: were the local source refused, preparing
 * the payload would go on to clone the source repository.
 */
const offline: Runner = (command, options) =>
  command[0] === 'git' && (command[1] === 'clone' || command[1] === 'fetch')
    ? Promise.resolve(failed())
    : runCommand(command, options);

Given(
  'a source checkout whose origin is the source repository of the fleet',
  async (world) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'fleet-bundle-'))
    );
    world.defer(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, 'source');
    await must(directory, 'init', '-q', source);
    await must(source, 'remote', 'add', 'origin', fleet.source.repository);
    world.bundle = { directory, source };
  }
);

const source = (world: OrchestrationWorld): string =>
  need(world.bundle.source, 'a source checkout');
const target = (world: OrchestrationWorld): string =>
  need(world.bundle.target, 'a new checkout');

Given(
  'it holds these scripts, each of the one line {string}:',
  async (world, line: string, table: DataTable) => {
    for (const path of table.list()) {
      const file = join(source(world), path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${line}\n`);
    }
  }
);

Given(
  'its first commit adds {string} holding {string}',
  async (world, path: string, contents: string) => {
    await writeFile(join(source(world), path), contents);
    await must(source(world), 'add', '-A');
    await must(source(world), 'commit', '-qm', 'first');
  }
);

Given(
  'its second commit removes {string} and adds {string} holding {string}',
  async (world, removed: string, added: string, contents: string) => {
    await must(source(world), 'rm', '-q', removed);
    await writeFile(join(source(world), added), contents);
    await must(source(world), 'add', '-A');
    await must(source(world), 'commit', '-qm', 'second');
    world.bundle.revision = await must(source(world), 'rev-parse', 'HEAD');
  }
);

When(
  'the second commit is bundled for a worker and fetched into a new checkout that is shallow at it',
  async (world) => {
    const directory = need(world.bundle.directory, 'a source checkout');
    const revision = need(world.bundle.revision, 'a second commit');
    const payload = await prepareBootstrap(directory, revision, offline, {
      checkout: source(world),
    });
    world.bundle.payload = payload;
    if (!payload) return;
    const file = join(directory, 'received.bundle');
    await writeFile(file, Buffer.from(payload.bundle, 'base64'));
    world.bundle.file = file;
    const checkout = join(directory, 'target');
    await must(directory, 'init', '-q', checkout);
    world.bundle.target = checkout;
    // What fleet-remote-bootstrap.sh does on the worker.
    await writeFile(join(checkout, '.git/shallow'), revision + '\n');
    world.bundle.fetched = (
      await git(checkout, 'fetch', '--no-tags', file, revision)
    ).ok;
    world.bundle.checkedOut = (
      await git(checkout, 'checkout', '--detach', revision)
    ).ok;
  }
);

Then('the payload names the second commit', (world) => {
  expect(world.bundle.payload?.revision).toBe(
    need(world.bundle.revision, 'a second commit')
  );
});

Then('the new checkout fetched the commit from the bundle', (world) => {
  expect(world.bundle.fetched).toBe(true);
});

Then('the new checkout checked the commit out', (world) => {
  expect(world.bundle.checkedOut).toBe(true);
});

Then(
  '{string} in the new checkout holds {string}',
  async (world, path: string, contents: string) => {
    expect(await readFile(join(target(world), path), 'utf8')).toBe(contents);
  }
);

Then('the new checkout has no uncommitted change', async (world) => {
  expect((await git(target(world), 'status', '--porcelain')).stdout).toBe('');
});

Then(
  'the new checkout has {int} commit(s) of history',
  async (world, count: number) => {
    expect(
      (await git(target(world), 'rev-list', '--count', 'HEAD')).stdout.trim()
    ).toBe(String(count));
  }
);

Then('the new checkout passes {string}', async (world, command: string) => {
  const [executable, ...args] = command.split(' ');
  expect(executable).toBe('git');
  expect((await git(target(world), ...args)).ok).toBe(true);
});

Then('the bundle nowhere contains {string}', async (world, text: string) => {
  expect(
    (await readFile(need(world.bundle.file, 'a bundle'))).includes(text)
  ).toBe(false);
});
