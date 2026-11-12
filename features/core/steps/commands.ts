import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import { failed, succeeded } from '../../support/commands';
import type { Check, Status } from '../../../src/types';
import { control, core, startsWith, type CoreWorld } from './world';

/** What a scenario says commands answer, what it says was run, and what it
 * says of the checks that came back: the steps every feature of this area
 * shares.
 */
const { Given, Then } = core;

// ── What a command answers ───────────────────────────────────────────────

Given(
  'the command {string} prints {string}',
  (world, line: string, output: string) => {
    world.commands.answer(startsWith(line), succeeded(control(output)));
  }
);

Given(
  'the command {string} succeeds and says {string} on standard error',
  (world, line: string, stderr: string) => {
    world.commands.answer(startsWith(line), { ...succeeded(), stderr });
  }
);

Given('the command {string} fails', (world, line: string) => {
  world.commands.answer(startsWith(line), failed());
});

Given(
  'the command {string} fails with the error {string}',
  (world, line: string, stderr: string) => {
    world.commands.answer(startsWith(line), failed(stderr));
  }
);

Given('these commands print:', (world, table: DataTable) => {
  // The longer line is the more exact one, and the answer given last wins.
  const rows = table
    .hashes()
    .sort(
      (a, b) =>
        a['command']!.split(' ').length - b['command']!.split(' ').length
    );
  for (const row of rows)
    world.commands.answer(
      startsWith(row['command']!),
      succeeded(control(row['prints']!))
    );
});

Given('every (other )command prints {string}', (world, output: string) => {
  world.commands.otherwise = succeeded(control(output));
});

Given('every command prints:', (world, output: string) => {
  world.commands.otherwise = succeeded(control(output));
});

Given('every command fails', (world) => {
  world.commands.otherwise = failed();
});

Given(
  'every command fails with the error {string}',
  (world, stderr: string) => {
    world.commands.otherwise = failed(stderr);
  }
);

Given('every command fails, printing {string}', (world, stdout: string) => {
  world.commands.otherwise = { ...failed(), stdout };
});

// ── What was run ─────────────────────────────────────────────────────────

const lines = (world: CoreWorld): string[][] =>
  world.commands.calls.map((call) => call.command);

/** The commands a step speaks of; a scenario that ran none proves nothing. */
function ran(world: CoreWorld): string[][] {
  expect(lines(world).length).toBeGreaterThan(0);
  return lines(world);
}

Then('the only command run was:', (world, table: DataTable) => {
  expect(lines(world)).toEqual([table.raw()[0]!]);
});

Then(
  'the first {string} command run was:',
  (world, name: string, table: DataTable) => {
    expect(lines(world).find((command) => command[0] === name)).toEqual(
      table.raw()[0]!
    );
  }
);

Then('exactly {int} command(s) was/were run', (world, count: number) => {
  expect(lines(world)).toHaveLength(count);
});

Then('only {string} commands were run', (world, name: string) => {
  for (const command of ran(world)) expect(command[0]).toBe(name);
});

Then('no {string} command was run', (world, name: string) => {
  expect(lines(world).some((command) => command[0] === name)).toBe(false);
});

Then(
  'every command was run with the argument {string}',
  (world, argument: string) => {
    for (const command of ran(world)) expect(command).toContain(argument);
  }
);

Then(
  'no command was run with the argument {string}',
  (world, argument: string) => {
    expect(lines(world).some((command) => command.includes(argument))).toBe(
      false
    );
  }
);

Then('no command line contains {string}', (world, text: string) => {
  for (const command of ran(world))
    expect(JSON.stringify(command)).not.toContain(text);
});

Then(
  'every {string} command was given {string} on standard input',
  (world, name: string, input: string) => {
    const named = world.commands.calls.filter(
      (call) => call.command[0] === name
    );
    expect(named.length).toBeGreaterThan(0);
    for (const call of named) expect(call.options?.input).toBe(control(input));
  }
);

Then(
  'every command was given {int} seconds to answer',
  (world, seconds: number) => {
    expect(world.commands.calls.length).toBeGreaterThan(0);
    for (const call of world.commands.calls)
      expect(call.options?.timeoutMs).toBe(seconds * 1000);
  }
);

// ── What came back ───────────────────────────────────────────────────────

const STATUS: Record<string, Status> = {
  passes: 'pass',
  pass: 'pass',
  fails: 'fail',
  fail: 'fail',
  warns: 'warn',
  warn: 'warn',
  'is skipped': 'skip',
  'are skipped': 'skip',
  'is not applicable': 'not-applicable',
};

function checks(world: CoreWorld): Check[] {
  if (world.failure) throw world.failure;
  return world.checks;
}

/** The one check of that name. */
function checkNamed(world: CoreWorld, id: string): Check {
  const named = checks(world).filter((check) => check.id === id);
  expect(named.map((check) => check.id)).toEqual([id]);
  return named[0]!;
}

Then(
  /^the check "([^"]+)" (passes|fails|warns|is skipped|is not applicable)$/,
  (world, id: string, verdict: string) => {
    expect(checkNamed(world, id).status).toBe(STATUS[verdict]!);
  }
);

Then(
  /^(\d+) checks (pass|fail|warn|are skipped)$/,
  (world, count: number, verdict: string) => {
    expect(
      checks(world).filter((check) => check.status === STATUS[verdict])
    ).toHaveLength(Number(count));
  }
);

Then('there is no check {string}', (world, id: string) => {
  expect(checks(world).map((check) => check.id)).not.toContain(id);
});

Then('every check passes', (world) => {
  expect(checks(world).length).toBeGreaterThan(0);
  expect(checks(world).every((check) => check.status === 'pass')).toBe(true);
});

Then('these checks are skipped, in this order:', (world, table: DataTable) => {
  expect(
    checks(world)
      .filter((check) => check.status === 'skip')
      .map((check) => check.id)
  ).toEqual(table.list());
});

Then(
  'these skipped checks say {string} and where their access is proven:',
  (world, code: string, table: DataTable) => {
    const ids = table.list();
    const skipped = checks(world).filter(
      (check) => check.status === 'skip' && ids.includes(check.id)
    );
    expect(skipped.map((check) => check.id)).toEqual(ids);
    for (const check of skipped) {
      expect(check.summary).toStartWith(`${code}: `);
      expect(check.summary.length).toBeGreaterThan(code.length + 20);
      expect(check.required).toBe(false);
    }
  }
);

Then('the checks are, in this order:', (world, table: DataTable) => {
  expect(
    checks(world).map((check) => ({ id: check.id, status: check.status }))
  ).toEqual(table.hashes() as { id: string; status: Status }[]);
});

Then(
  'the summary of the check {string} mentions {string}',
  (world, id: string, text: string) => {
    expect(checkNamed(world, id).summary).toContain(text);
  }
);

Then(
  'the remedy of the check {string} mentions {string}',
  (world, id: string, text: string) => {
    expect(checkNamed(world, id).remedy?.action).toContain(text);
  }
);

Then('nothing reported contains {string}', (world, text: string) => {
  if (world.failure) throw world.failure;
  expect(world.outcome).toBeDefined();
  expect(JSON.stringify(world.outcome)).not.toContain(text);
});

Then('it is refused', (world) => {
  expect(world.failure).toBeInstanceOf(Error);
});

Then('it is refused, saying {string}', (world, text: string) => {
  expect(world.failure).toBeInstanceOf(Error);
  expect(world.failure?.message).toContain(text);
});

// ── What a When wrote ────────────────────────────────────────────────────

const written = (world: CoreWorld): string => {
  if (world.failure) throw world.failure;
  expect(world.text).toBeString();
  return world.text!;
};

Then('it contains {string}', (world, text: string) => {
  expect(written(world)).toContain(text);
});

Then('it does not contain {string}', (world, text: string) => {
  expect(written(world)).not.toContain(text);
});

Then('it is more than {int} characters long', (world, length: number) => {
  expect(written(world).length).toBeGreaterThan(length);
});
