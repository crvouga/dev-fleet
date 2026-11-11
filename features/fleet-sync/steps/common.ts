import { expect } from 'bun:test';
import type { Status } from '../../../src/types';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  fleetSync,
  forbid,
  nested,
  rosterEntry,
  setEnv,
} from '../support/world';

const { Given, Then } = fleetSync;

// ── Where devfleet runs ──────────────────────────────────────────────────

Given(
  /^devfleet(?: "([^"]*)")? runs from "([^"]*)" with the roster "([^"]*)"$/,
  (world, version: string | undefined, workspace: string, config: string) => {
    if (version) world.version = version;
    world.settings = { workspace, config };
  }
);

Given(
  'the environment sets {string} to {string}',
  (world, name: string, value: string) => {
    setEnv(world, name, value);
  }
);

Given(
  /^the roster entry "([^"]*)", with the workspace "([^"]*)"(?: and the Tailscale ID "([^"]*)")?$/,
  (world, id: string, workspace: string, tailscaleId: string | undefined) => {
    world.node = {
      id,
      ssh: id,
      workspace,
      ...(tailscaleId ? { tailscaleId } : {}),
      required: [],
    };
  }
);

Given('the roster enrolls:', (world, table: DataTable) => {
  world.roster = table.hashes().map(rosterEntry);
});

Given('the roster enrolls nobody', (world) => {
  world.roster = [];
});

// ── What commands answer ─────────────────────────────────────────────────

Given('this machine is a worker, where no command is found', (world) => {
  // No scutil, no checkout.
  world.commands.otherwise = {
    ok: false,
    reason: 'missing',
    stdout: '',
    stderr: '',
  };
});

Given('any command would fail the scenario', (world) => {
  world.commands.answer(() => true, forbid(world, 'run a command'));
});

Given('every command on a worker succeeds', (world) => {
  world.commands.otherwise = succeeded();
});

Given(
  'every command on a worker fails with {string}',
  (world, stderr: string) => {
    world.commands.otherwise = failed(stderr);
  }
);

// ── What was run ─────────────────────────────────────────────────────────

Then('no command was run', (world) => {
  expect(world.commands.calls.map((call) => call.command)).toEqual([]);
});

Then('{int} command was run', (world, count: number) => {
  expect(world.commands.calls).toHaveLength(count);
});

Then('exactly these commands were run:', (world, table: DataTable) => {
  expect(world.commands.calls.map((call) => call.command)).toEqual(
    table.list().map((line) => line.split(' '))
  );
});

Then('nothing but {string} was run', (world, name: string) => {
  expect(world.commands.calls.every((call) => call.command[0] === name)).toBe(
    true
  );
});

Then('no command was run over SSH', (world) => {
  expect(world.commands.calls.some((call) => call.command[0] === 'ssh')).toBe(
    false
  );
});

Then(
  'the first command run has the argument {string}',
  (world, argument: string) => {
    expect(world.commands.calls[0]?.command).toContain(argument);
  }
);

Then(
  'every command run has the argument {string}',
  (world, argument: string) => {
    for (const call of world.commands.calls)
      expect(call.command).toContain(argument);
  }
);

Then('every command run ends with {string}', (world, last: string) => {
  for (const call of world.commands.calls)
    expect(call.command.at(-1)).toBe(last);
});

Then('no command line contains {string}', (world, text: string) => {
  expect(
    world.commands.calls.every((call) => !call.command.join(' ').includes(text))
  ).toBe(true);
});

// ── What a command returned ──────────────────────────────────────────────

Then('the command exits with {int}', (world, code: number) => {
  expect(world.outcome?.exitCode).toBe(code);
});

Then('the report has:', (world, table: DataTable) => {
  expect(world.outcome?.data).toMatchObject(nested(table));
});

Then('the report mentions {string}', (world, text: string) => {
  expect(JSON.stringify(world.outcome?.data)).toContain(text);
});

Then('the report does not mention {string}', (world, text: string) => {
  expect(JSON.stringify(world.outcome?.data)).not.toContain(text);
});

Then('the command prints {string}', (world, text: string) => {
  expect(world.outcome?.text).toBe(text);
});

Then("the command's output names each of:", (world, table: DataTable) => {
  for (const text of table.list()) expect(world.outcome?.text).toContain(text);
});

Then(
  'the result is exactly exit code {int} and the report:',
  (world, code: number, json: string) => {
    expect(world.outcome).toEqual({ exitCode: code, data: JSON.parse(json) });
  }
);

Then('the request is refused', (world) => {
  expect(world.failure).toBeInstanceOf(Error);
});

Then('the answer is {string}', (world, answer: string) => {
  expect(world.answer).toBe(answer);
});

// ── Checks ───────────────────────────────────────────────────────────────

Then('there are no checks', (world) => {
  expect(world.checks).toEqual([]);
});

Then('the first check is {string}', (world, id: string) => {
  expect(world.checks[0]?.id).toBe(id);
});

Then(
  /^the (?:first )?check's status is "([^"]*)"$/,
  (world, status: Status) => {
    expect(world.checks[0]?.status).toBe(status);
  }
);

Then(
  /^the (?:first )?check's summary is "([^"]*)"$/,
  (world, summary: string) => {
    expect(world.checks[0]?.summary).toBe(summary);
  }
);

Then(
  /^the (?:first )?check's remedy contains "([^"]*)"$/,
  (world, text: string) => {
    expect(world.checks[0]?.remedy?.action).toContain(text);
  }
);

Then('the statuses of the checks are exactly:', (world, table: DataTable) => {
  expect(world.checks.map((check) => check.status)).toEqual(
    table.list() as Status[]
  );
});

Then('the summaries of the checks are exactly:', (world, table: DataTable) => {
  expect(world.checks.map((check) => check.summary)).toEqual(table.list());
});

Then('the checks do not mention {string}', (world, text: string) => {
  expect(JSON.stringify(world.checks)).not.toContain(text);
});

// ── An SSH command a step prepared ───────────────────────────────────────

Then('the SSH command has these arguments:', (world, table: DataTable) => {
  for (const argument of table.list())
    expect(world.command).toContain(argument);
});

Then(
  'the SSH command connects as the user {string} to {string}',
  (world, user: string, host: string) => {
    expect(world.command).toContain(`${user}@${host}`);
  }
);

Then(
  'the SSH command does not have the argument {string}',
  (world, argument: string) => {
    expect(world.command).not.toContain(argument);
  }
);
