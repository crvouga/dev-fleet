import { expect } from 'bun:test';
import { existsSync } from 'node:fs';
import type { CommandOutcome } from '../../../src/cli/contracts';
import {
  fleetState,
  type FleetStateOptions,
} from '../../../src/cli/fleet-state';
import { execute } from '../../../src/cli/program';
import { parseDefinition } from '../../../src/definition';
import { readDocument } from '../../../src/state/store';
import type { DataTable } from '../../support/gherkin';
import {
  STATE,
  WHO,
  act,
  json,
  phrase,
  scratch,
  state,
  type Manager,
  type StateWorld,
} from './world';

const { Given, When, Then } = state;

const SWITCHES = ['init', 'export', 'example', 'push', 'restore', 'yes'];
const VALUES = [
  'bucket',
  'endpoint',
  'region',
  'prefix',
  'directory',
  'import',
];

/** A `fleet-state` command line as its options, each value expanded. */
function options(
  world: StateWorld,
  manager: Manager,
  command: string
): FleetStateOptions {
  const [name, ...words] = command.split(' ');
  if (name !== 'fleet-state') throw new Error(`Not fleet-state: ${command}`);
  const parsed: Record<string, string | boolean> = {};
  while (words.length > 0) {
    const flag = words.shift()!.replace(/^--/, '');
    if (SWITCHES.includes(flag)) parsed[flag] = true;
    else if (VALUES.includes(flag))
      parsed[flag] = world.expand(words.shift() ?? '', manager);
    else throw new Error(`fleet-state has no --${flag}`);
  }
  return parsed as FleetStateOptions;
}

/** `fleet-state` as the operator runs it on one manager: in its home, with
 * what its commands are passed, and no terminal unless a scenario gives one.
 */
function run(
  world: StateWorld,
  manager: Manager,
  command: string
): Promise<CommandOutcome> {
  return fleetState(options(world, manager, command), {
    run: manager.run,
    env: manager.env,
    home: manager.home,
    ask: manager.ask,
  });
}

Given(
  phrase('the operator (runs|ran|tried) "([^"]+)" on ', WHO),
  (world, verb: string, command: string, name: string | undefined) =>
    act(world, verb, () => run(world, world.manager(name), command))
);

const asked = scratch<string[]>(() => []);

Given(
  phrase(
    'the operator at the terminal of ',
    WHO,
    ' answers "([^"]*)" when asked for a secret and "([^"]*)" otherwise'
  ),
  (world, name: string | undefined, secret: string, other: string) => {
    world.manager(name).ask = async (question) => {
      asked(world).push(question);
      return question.includes('secret') ? secret : other;
    };
  }
);
Then('the operator was asked exactly:', (world, table: DataTable) => {
  expect(asked(world)).toEqual(table.list());
});

// The devfleet program itself, with the state directory and bucket.json this
// process was given.
When('devfleet is started with {string}', (world, line: string) =>
  world.attempt(() =>
    execute(
      line.split(' '),
      { workspace: '/no-checkout', config: '/no-roster' },
      '0.1.0'
    )
  )
);

// ── What a command returned ──────────────────────────────────────────────

const outcome = (world: StateWorld): CommandOutcome =>
  world.outcome<CommandOutcome>();

const checks = (data: unknown): Record<string, string> =>
  Object.fromEntries(
    (
      data as { nodes: [{ checks: { id: string; status: string }[] }] }
    ).nodes[0].checks.map((check) => [check.id, check.status])
  );

Then('the command exits {int}', (world, code: number) => {
  expect(outcome(world).exitCode).toBe(code);
});
Then('the report lists exactly these checks:', (world, table: DataTable) => {
  expect(checks(outcome(world).data)).toEqual(table.rowsHash());
});
Then('the report includes these checks:', (world, table: DataTable) => {
  expect(checks(outcome(world).data)).toMatchObject(table.rowsHash());
});
Then('the report includes:', (world, text: string) => {
  expect(outcome(world).data).toMatchObject(json(text) as object);
});
Then('the report contains {string}', (world, text: string) => {
  expect(JSON.stringify(outcome(world).data)).toContain(text);
});
Then(
  phrase('the report names the state directory of ', WHO, ' as its root'),
  (world, name: string | undefined) => {
    expect(outcome(world).data).toMatchObject({
      root: world.manager(name).root,
    });
  }
);
Then('the output contains {string}', (world, text: string) => {
  expect(outcome(world).text).toContain(text);
});
Then('the output does not contain {string}', (world, text: string) => {
  expect(outcome(world).text).not.toContain(text);
});
Then('the output contains each of:', (world, table: DataTable) => {
  for (const text of table.list()) expect(outcome(world).text).toContain(text);
});
Then(
  'nothing the command returned contains {string}',
  (world, text: string) => {
    expect(JSON.stringify(outcome(world))).not.toContain(text);
  }
);

Then(
  phrase('the output is the configuration in ', STATE),
  (world, name: string | undefined) => {
    expect(json(outcome(world).text!)).toEqual(
      json(readDocument(world.manager(name).database, 'definition')!)
    );
  }
);

const reported = (world: StateWorld): Record<string, unknown> =>
  (outcome(world).data as { definition: Record<string, unknown> }).definition;

Then('the output is the configuration in the report', (world) => {
  expect(json(outcome(world).text!)).toEqual(reported(world));
});
Then(
  'the configuration in the report has {string} set to {string}',
  (world, key: string, value: string) => {
    expect(reported(world)[key]).toBe(value);
  }
);
Then(
  'the configuration in the report is valid and names the bucket {string}',
  (world, bucket: string) => {
    expect(parseDefinition(reported(world)).state).toMatchObject({ bucket });
  }
);

Then(phrase(WHO, ' has no state directory'), (world, name?: string) => {
  expect(existsSync(world.manager(name).root)).toBe(false);
});
