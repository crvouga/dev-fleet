import { expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetSync as runFleetSync } from '../../../src/cli/fleet-sync';
import {
  managerRunScript,
  rehome,
  runFromCheckout,
} from '../../../src/cli/fleet-sync-checkout';
import {
  forwardedFlags,
  forwardToManager,
  managerCommand,
} from '../../../src/cli/fleet-sync-forward';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  definition,
  escaped,
  fleetSync,
  flags,
  forbid,
  request,
  setEnv,
  temporary,
  type FleetSyncWorld,
} from '../support/world';

const { Given, When, Then } = fleetSync;

/** A script file ends with a new line; a doc string does not. */
const scriptText = (text: string): string => `${text}\n`;

// ── The hand-off from a worker ───────────────────────────────────────────

Given('the run script tracked at the revision is:', (world, text: string) => {
  world.script = scriptText(text);
});

function prepare(
  world: FleetSyncWorld,
  command: string,
  revision: string | undefined
): void {
  const options = request(command);
  world.command = managerCommand(definition, options, revision, world.script);
  world.forwarded = forwardedFlags(options, revision);
}

When(
  'a worker prepares to hand {string} at revision {string} to the manager',
  (world, command: string, revision: string) => {
    prepare(world, command, revision);
  }
);

When(
  'a worker prepares to hand {string} with no revision to the manager',
  (world, command: string) => {
    prepare(world, command, undefined);
  }
);

Then(
  'what the manager is asked to run contains:',
  (world, table: DataTable) => {
    for (const text of table.list())
      expect(world.command.at(-1)).toContain(text);
  }
);

Then(
  'what the manager is asked to run does not contain {string}',
  (world, text: string) => {
    expect(world.command.at(-1)).not.toContain(text);
  }
);

Then(
  'what the manager is asked to run names {string} directly followed by {string}',
  (world, first: string, second: string) => {
    // Each word is quoted for the shell, so only punctuation separates them.
    expect(world.command.at(-1)).toMatch(
      new RegExp(`${escaped(first)}\\W+${escaped(second)}`)
    );
  }
);

Then('the manager is asked for exactly {string}', (world, text: string) => {
  expect(world.forwarded).toEqual(text.split(' '));
});

// ── What the hand-off, or the run from a checkout, answers ───────────────

function answers(
  world: FleetSyncWorld,
  exitCode: number,
  stdout: string
): void {
  world.spawn = async (command) => {
    world.spawned.push(command);
    return { exitCode, stdout };
  };
}

Given(
  /^(?:the manager answers the hand-off|the run from the checkout answers) with exit code (\d+) and:$/,
  (world, code: number, stdout: string) => {
    answers(world, Number(code), stdout);
  }
);

Given(
  /^(?:the manager answers the hand-off|the run from the checkout answers) with exit code (\d+) and "([^"]*)"$/,
  (world, code: number, stdout: string) => {
    answers(world, Number(code), stdout);
  }
);

Given(
  'the manager answers the hand-off with exit code {int} and nothing',
  (world, code: number) => {
    answers(world, code, '');
  }
);

Given('a hand-off would fail the scenario', (world) => {
  world.spawn = forbid(world, 'hand off to the manager');
});

Given('starting a run would fail the scenario', (world) => {
  world.spawn = forbid(world, 'start a run');
});

Given('nothing stands in for the SSH connection to the manager', (world) => {
  world.spawn = undefined;
});

When('fleet-sync is started with {string}', async (world, text: string) => {
  world.outcome = await runFleetSync(
    flags(text),
    world.settings,
    world.commands.run,
    world.spawn
  );
});

When(
  '{string} at revision {string} is handed to the manager',
  async (world, command: string, revision: string) => {
    // Without a stand-in the hand-off must refuse: only a test is refused.
    expect(process.env['NODE_ENV']).toBe('test');
    try {
      world.outcome = await forwardToManager(
        definition,
        request(command),
        revision,
        { spawn: world.spawn }
      );
    } catch (error) {
      world.failure = error as Error;
    }
  }
);

Then('{int} command was handed to the manager', (world, count: number) => {
  expect(world.spawned).toHaveLength(count);
});

Then('the hand-off is refused with {string}', (world, message: string) => {
  expect(world.failure?.message).toContain(message);
});

// ── Git, as the manager sees it ──────────────────────────────────────────

/** A Git that holds the revision in the directories listed, and in whatever
 * it clones, and nowhere else.
 */
function git(world: FleetSyncWorld, revision: string, holders: string[]): void {
  const cloned = new Set<string>();
  const repository = definition.source.repository;
  world.commands.answer(
    () => true,
    (args, options) => {
      if (args[1] === 'clone') {
        cloned.add(args.at(-1)!);
        return succeeded('');
      }
      const cwd = options?.cwd ?? '';
      if (!holders.includes(cwd) && !cloned.has(cwd)) return failed();
      if (args[1] === 'remote') return succeeded(`${repository}\n`);
      if (args.includes('--show-toplevel')) return succeeded(`${cwd}\n`);
      if (args[1] === 'rev-parse') return succeeded(`${revision}\n`);
      return succeeded(args[1] === 'show' ? (world.script ?? '') : '');
    }
  );
}

Given(
  "only the checkout {string} of the fleet's source repository holds revision {string}, with the run script:",
  (world, checkout: string, revision: string, text: string) => {
    world.script = scriptText(text);
    git(world, revision, [checkout]);
  }
);

Given(
  "only a clone of the fleet's source repository holds revision {string}, with the run script:",
  (world, revision: string, text: string) => {
    world.script = scriptText(text);
    git(world, revision, []);
  }
);

Given('Git is offline and no directory holds any revision', (world) => {
  world.commands.otherwise = failed();
});

// ── A sync on the manager ────────────────────────────────────────────────

const caches = (world: FleetSyncWorld): string =>
  (world.caches ??= temporary(world, 'fleet-run-source-'));

function source(world: FleetSyncWorld, revision: string, workspace: string) {
  // The run names its repository in the environment of this process.
  setEnv(world, 'DEVFLEET_REPO', process.env['DEVFLEET_REPO']);
  return { revision, workspace, root: caches(world) };
}

When(
  'the manager starts {string} at revision {string} from {string}',
  async (world, command: string, revision: string, workspace: string) => {
    world.outcome = await runFromCheckout(
      request(command),
      source(world, revision, workspace),
      world.commands.run,
      world.spawn ?? forbid(world, 'start a run')
    );
  }
);

When(
  'the manager decides where to run {string} at revision {string}, started from {string}',
  async (world, command: string, revision: string, workspace: string) => {
    world.answer = await rehome(
      request(command),
      source(world, revision, workspace),
      world.commands.run
    );
  }
);

Then(
  'it starts "sh -c" with that run script and the arguments {string}',
  (world, text: string) => {
    expect(world.spawned[0]).toEqual([
      'sh',
      '-c',
      world.script!,
      ...text.split(' '),
    ]);
  }
);

Then(
  /^the run is told its repository is "([^"]*)"$/,
  (_world, path: string) => {
    expect(process.env['DEVFLEET_REPO']).toBe(path);
  }
);

Then(
  "the run is told its repository is {string} in the manager's caches",
  (world, directory: string) => {
    expect(process.env['DEVFLEET_REPO']).toBe(join(caches(world), directory));
  }
);

Then(
  "Git cloned the fleet's source repository with {string} into {string} in the manager's caches",
  (world, options: string, directory: string) => {
    expect(world.commands.ran((args) => args[1] === 'clone')[0]).toEqual([
      'git',
      'clone',
      ...options.split(' '),
      definition.source.repository,
      join(caches(world), directory),
    ]);
  }
);

Then('there is no run', (world) => {
  expect(world.outcome).toBeNull();
});

// ── The run script a hand-off sends ──────────────────────────────────────

function ships(
  world: FleetSyncWorld,
  revision: string | null,
  text: string
): void {
  const root = temporary(world, 'fleet-package-');
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(join(root, 'bootstrap/fleet-manager-run.sh'), scriptText(text));
  world.shipped = { revision, root };
}

Given(
  'an installed package published from revision {string} that ships the run script:',
  (world, revision: string, text: string) => {
    ships(world, revision, text);
  }
);

Given(
  'a package that names no revision and ships the run script:',
  (world, text: string) => {
    ships(world, null, text);
  }
);

When(
  'the run script of revision {string} is looked up from {string}',
  async (world, revision: string, workspace: string) => {
    world.answer = await managerRunScript(
      workspace,
      revision,
      world.commands.run,
      world.shipped!
    );
  }
);

Then('it is the run script:', (world, text: string) => {
  expect(world.answer).toBe(scriptText(text));
});

Then('there is no run script', (world) => {
  expect(world.answer).toBeNull();
});
