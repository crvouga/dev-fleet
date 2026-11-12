import { expect } from 'bun:test';
import { renewWorkerVault } from '../../../bootstrap/worker-auth';
import { workerTools } from '../../../bootstrap/worker-tools';
import { authorizePrivilege } from '../../../src/cli/fleet-sync-privilege';
import {
  authorizeManager,
  authorizeVault,
  remote,
  workerTokenField,
  type TerminalRunner,
} from '../../../src/cli/fleet-sync-vault';
import type { CommandResult } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { fleetSync, forbid, type FleetSyncWorld } from '../support/world';

const { Given, When, Then } = fleetSync;

/** What only these steps keep between them. */
interface Authorization {
  attach: TerminalRunner | undefined;
  /** The command line of each prompt that had the operator's terminal. */
  prompts: string[][];
  loggedIn: boolean | undefined;
  tools: Record<string, { version: string }>;
  selected: string[] | undefined;
  renewal: { status: number; stdout: string } | undefined;
  renewed: boolean | undefined;
}
const states = new WeakMap<FleetSyncWorld, Authorization>();

function state(world: FleetSyncWorld): Authorization {
  let found = states.get(world);
  if (!found) {
    found = {
      attach: undefined,
      prompts: [],
      loggedIn: undefined,
      tools: {},
      selected: undefined,
      renewal: undefined,
      renewed: undefined,
    };
    states.set(world, found);
  }
  return found;
}

/** A terminal nobody described must not be used: nothing here prompts a person. */
const attach = (world: FleetSyncWorld): TerminalRunner =>
  state(world).attach ?? forbid(world, 'prompt on the terminal');

// ── Vault sessions ───────────────────────────────────────────────────────

/** Answers in turn, then keeps failing. */
function inTurn(answers: CommandResult[]): () => CommandResult {
  const queue = [...answers];
  return () => queue.shift() ?? failed();
}

const LOOKUP: Record<string, CommandResult> = {
  yes: succeeded(),
  no: failed(),
  // The lookup could not start: the node has no vault yet.
  'vault-missing': { ...failed(), stdout: 'vault-missing' },
};

Given(
  'looking up the Vault session answers, in turn, {string}',
  (world, answers: string) => {
    world.commands.answer(
      /token.*lookup/,
      inTurn(answers.split(',').map((answer) => LOOKUP[answer.trim()]!))
    );
  }
);

Given(
  'Vault holds the issued token {string} for that machine',
  (world, token: string) => {
    world.commands.answer(/kv.*get/, inTurn([succeeded(`${token}\n`)]));
  }
);

Given('that machine accepts a login with a token', (world) => {
  world.commands.answer(/vault' 'login/, inTurn([succeeded()]));
});

Given('a prompt on the terminal would fail the scenario', (world) => {
  state(world).attach = forbid(world, 'prompt on the terminal');
});

Given('the operator completes every prompt on the terminal', (world) => {
  state(world).attach = (args) => {
    state(world).prompts.push(args);
    return true;
  };
});

const interactive = (mode: string): boolean => mode.includes('an interactive');

When(
  /^the Vault session of that machine is authorized in (an interactive|a noninteractive) sync$/,
  async (world, mode: string) => {
    world.checks = await authorizeVault(
      world.node!,
      { interactive: interactive(mode) },
      world.commands.run,
      attach(world)
    );
  }
);

When(
  /^the Vault session of the manager is authorized in (an interactive|a noninteractive) sync$/,
  async (world, mode: string) => {
    state(world).loggedIn = await authorizeManager(
      { interactive: interactive(mode) },
      world.commands.run,
      attach(world)
    );
  }
);

When(
  '{string} is prepared for that machine with a terminal',
  (world, command: string) => {
    world.command = remote(world.node!, command.split(' '), '-t');
  }
);

Then(
  'the issued token of {string} is kept in the Vault field {string}',
  (_world, node: string, field: string) => {
    expect(workerTokenField(node)).toBe(field);
  }
);

Then(
  'the token was read from Vault with {string}',
  (world, argument: string) => {
    const read = world.commands.calls.find((call) =>
      /kv get/.test(call.command.join(' '))
    );
    expect(read?.command.join(' ')).toContain(argument);
  }
);

Then(
  'the login on that machine was given {string} and a new line on standard input',
  (world, token: string) => {
    const login = world.commands.calls.find((call) =>
      /vault' 'login/.test(call.command.join(' '))
    );
    expect(login?.options?.input).toBe(`${token}\n`);
  }
);

Then(
  'the first prompt has the argument {string}',
  (world, argument: string) => {
    expect(state(world).prompts[0]).toContain(argument);
  }
);

Then(
  'the first prompt ends with a command that contains {string}',
  (world, text: string) => {
    expect(state(world).prompts[0]?.at(-1)).toContain(text);
  }
);

Then(/^the manager is (logged in|not logged in)$/, (world, result: string) => {
  expect(state(world).loggedIn).toBe(result === 'logged in');
});

Then('the operator was prompted {int} times', (world, count: number) => {
  expect(state(world).prompts.length).toBe(count);
});

// ── sudo ─────────────────────────────────────────────────────────────────

When(
  /^the privilege of that machine is authorized, with (?:no authorization script|the authorization script "([^"]*)")$/,
  async (world, script: string | undefined) => {
    world.checks = await authorizePrivilege(
      world.node!,
      script ?? undefined,
      world.commands.run
    );
  }
);

// ── What a worker does for itself ────────────────────────────────────────

Given(
  'these tools are each pinned at version {string}:',
  (world, version: string, table: DataTable) => {
    state(world).tools = Object.fromEntries(
      table.list().map((tool) => [tool, { version }])
    );
  }
);

function select(world: FleetSyncWorld, selected: unknown): void {
  try {
    state(world).selected = Object.keys(
      workerTools(state(world).tools, selected)
    );
  } catch (error) {
    world.failure = error as Error;
  }
}

// One comma-separated value, as the profile is written on a command line.
When("a worker's profile selects {string}", (world, selected: string) => {
  select(world, selected);
});

When("a worker's profile selects these tools:", (world, table: DataTable) => {
  select(world, table.list());
});

Then(
  'the worker installs exactly these tools, in this order:',
  (world, table: DataTable) => {
    expect(state(world).selected).toEqual(table.list());
  }
);

Then('the profile is refused', (world) => {
  expect(world.failure).toBeInstanceOf(Error);
  expect(state(world).selected).toBeUndefined();
});

Given(
  'Vault answers the renewal with exit status {int} and:',
  (world, status: number, stdout: string) => {
    state(world).renewal = { status, stdout };
  }
);

When('the worker renews its Vault session', (world) => {
  state(world).renewed = renewWorkerVault(() => state(world).renewal!);
});

Then(/^the session is (renewed|not renewed)$/, (world, result: string) => {
  expect(state(world).renewed).toBe(result === 'renewed');
});
