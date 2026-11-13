import { expect } from 'bun:test';
import { leftoverControl } from './leftovers';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace } from '../../support/fixtures';
import { Command } from 'commander';
import { executeFleet, type FleetServices } from '../../../src/cli/fleet';
import { syncNode, type NodeSyncOptions } from '../../../src/cli/node-sync';
import type { CliOptions } from '../../../src/cli/options';
import { GLOBAL_OPTIONS } from '../../../src/cli/program';
import { registerFleet } from '../../../src/cli/register-fleet';
import type { CommandOutcome } from '../../../src/cli/contracts';
import { probe } from '../../../src/probe';
import { recordSchedule } from '../../../src/state/history';
import type { Report, Snapshot } from '../../../src/types';
import { Commands, failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import {
  at,
  cli,
  json,
  listed,
  outcome,
  part,
  proxy,
  temporary,
  where,
  type CliWorld,
} from './world';

const { Given, Then } = cli;

/** This machine's tools, and the workers it reaches, as a scenario describes
 * them. Nothing is started: every subprocess devfleet would run is answered
 * here and kept, so a step can say what was and was not run.
 */
class Machine {
  readonly commands = new Commands();
  /** What bundling the probe for workers gives; refused when not described. */
  probe: string | undefined;
  bundled = 0;
  /** What a worker answers a probe and a repair with. */
  snapshot: Snapshot | undefined;
  repaired = '';
  whileRepairing: (() => Promise<void>) | undefined;
  /** Every request a worker received, decoded. */
  readonly requests: Record<string, unknown>[] = [];
  /** The commit the package devfleet runs from names, when it runs from one,
   * and where this manager keeps its fleet-owned checkouts.
   */
  revision: string | undefined;
  runs: string | undefined;
}

export const machine = part((world) => {
  const described = new Machine();
  world.standIn = (args) => dispatch(world, described, args);
  return described;
});

/** The command and options of a command line, read by the definitions the
 * program itself registers.
 */
async function parse(
  world: CliWorld,
  args: string[]
): Promise<{ name: string; options: Record<string, unknown> }> {
  const parsed: { name: string; options: Record<string, unknown> }[] = [];
  const program = new Command()
    .name('devfleet')
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  for (const option of GLOBAL_OPTIONS)
    program.option(option.flag, option.description);
  registerFleet(program, where(world), () => undefined);
  for (const command of program.commands)
    command.action((_options: unknown, self: Command) => {
      parsed.push({ name: self.name(), options: self.optsWithGlobals() });
    });
  await program.parseAsync(args, { from: 'user' });
  if (!parsed[0]) throw new Error(`No command in: devfleet ${args.join(' ')}`);
  return parsed[0];
}

/** What the program does with a parsed command, with this machine's tools in
 * place of real subprocesses.
 */
async function dispatch(
  world: CliWorld,
  described: Machine,
  args: string[]
): Promise<CommandOutcome> {
  const { name, options: raw } = await parse(world, args);
  const options: CliOptions = { ...raw };
  // A repeatable flag that was not given is no selection at all.
  if (!options.node?.length) delete options.node;
  const services: FleetServices = {
    run: described.commands.run,
    source: async () => {
      described.bundled += 1;
      if (described.probe === undefined) throw new Error('must not bundle');
      return described.probe;
    },
    ...(leftoverControl(world) ? { tailnet: leftoverControl(world)! } : {}),
    ...(described.revision
      ? { revision: described.revision, runs: described.runs! }
      : {}),
  };
  if (name === 'fleet-status')
    return executeFleet(
      options.tailnet || options.workers ? 'health' : 'doctor',
      { ...options, ...(options.workers ? { managed: true } : {}) },
      where(world),
      services
    );
  if (name === 'fleet-repair')
    return executeFleet(
      options.list ? 'repairs' : 'repair',
      options,
      where(world),
      services
    );
  if (name === 'fleet-node-sync')
    return syncNode(
      { ...(raw as NodeSyncOptions), roster: proxy(world) },
      where(world),
      described.commands.run
    );
  throw new Error(`${name} has no stand-ins to run against.`);
}

// ── The tools on this machine ────────────────────────────────────────────

Given(/^every command on this (?:manager|machine) succeeds$/, (world) => {
  machine(world).commands.otherwise = succeeded();
});

Given(
  /^every command on this (?:manager|machine) prints "([^"]*)"$/,
  (world, output: string) => {
    machine(world).commands.otherwise = succeeded(output);
  }
);

Given(
  'a command with the argument {string} prints {string}',
  (world, argument: string, output: string) => {
    machine(world).commands.answer(
      (command) => command.includes(argument),
      succeeded(output)
    );
  }
);

Given(
  'a command with the argument {string} prints:',
  (world, argument: string, output: string) => {
    machine(world).commands.answer(
      (command) => command.includes(argument),
      succeeded(output)
    );
  }
);

Given(
  'the program {string} fails with {string}',
  (world, program: string, error: string) => {
    machine(world).commands.answer(
      (command) => command[0] === program,
      failed(error)
    );
  }
);

Given(
  'every program other than {string} fails with {string}',
  (world, program: string, error: string) => {
    machine(world).commands.answer(
      (command) => command[0] !== program,
      failed(error)
    );
  }
);

Given(/^no command may run on this (?:manager|machine)$/, (world) => {
  machine(world).commands.answer(
    () => true,
    () => {
      throw new Error('must not run');
    }
  );
});

Given('Tailscale reports this inventory:', (world, inventory: string) => {
  machine(world).commands.answer(
    (command) => command[0] === 'tailscale',
    succeeded(JSON.stringify(json(inventory)))
  );
});

// ── The workers it reaches ───────────────────────────────────────────────

/** A worker is sent a request as base64 at the end of the SSH command. */
function request(command: string[]): Record<string, unknown> {
  try {
    const encoded = /'([^']+)'$/.exec(command.at(-1) ?? '')?.[1] ?? '';
    return JSON.parse(Buffer.from(encoded, 'base64').toString()) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

Given('the probe sent to workers is {string}', (world, source: string) => {
  machine(world).probe = source;
});

// ── Running from the published package ───────────────────────────────────

/** The package as npm installs it: its manifest and tool pins, but no Git
 * history and no bun.lock.
 */
Given(
  'devfleet runs from a package published from the commit {string}',
  async (world, commit: string) => {
    const described = machine(world);
    const root = await temporary(world, 'fleet-home-');
    const installed = join(root, 'project/node_modules/@scope/dev-fleet');
    await mkdir(installed, { recursive: true });
    for (const file of ['package.json', 'mise.toml', 'mise.lock'])
      await writeFile(join(installed, file), '{}');
    described.revision = commit;
    described.runs = join(root, 'manager-runs');
    world.where = { ...where(world), workspace: installed };
  }
);

Given(
  'the manager has its fleet-owned checkout of that commit',
  async (world) => {
    const described = machine(world);
    // Made elsewhere, then moved where fleet-sync keeps it.
    const checkout = await workspace();
    await mkdir(described.runs!, { recursive: true });
    await rename(checkout, runCheckout(described));
  }
);

const runCheckout = (described: Machine): string =>
  join(described.runs!, described.revision!);

Then('Git was run only in the fleet-owned checkout', (world) => {
  const described = machine(world);
  const git = described.commands.calls.filter(
    (call) => call.command[0] === 'git'
  );
  expect(git.length).toBeGreaterThan(0);
  for (const call of git)
    expect(call.options?.cwd).toBe(runCheckout(described));
});

Given(
  /^every worker answers the probe as (this workspace|the fleet-owned checkout) does at the commit "([^"]*)"$/,
  async (world, reference: string, commit: string) => {
    const described = machine(world);
    described.snapshot = await probe(
      reference === 'this workspace'
        ? where(world).workspace
        : runCheckout(described),
      [],
      async (command) => succeeded(command.includes('rev-parse') ? commit : '')
    );
    described.commands.answer(
      (command) => command[0] === 'ssh',
      async (command) => {
        const received = request(command);
        described.requests.push(received);
        if (received['action'] !== 'repair')
          return succeeded(JSON.stringify(described.snapshot));
        await described.whileRepairing?.();
        return succeeded(described.repaired);
      }
    );
  }
);

Given('every worker answers a repair with:', (world, answer: string) => {
  machine(world).repaired = answer;
});

Given(
  'the roster file is overwritten with {string} while a worker is repaired',
  (world, text: string) => {
    machine(world).whileRepairing = () => writeFile(where(world).config, text);
  }
);

// ── What was run ─────────────────────────────────────────────────────────

const calls = (world: CliWorld): { command: string[]; input?: string }[] =>
  machine(world).commands.calls.map(({ command, options }) => ({
    command,
    ...(options?.input === undefined ? {} : { input: options.input }),
  }));
const over = (world: CliWorld, program: string) =>
  calls(world).filter(({ command }) => command[0] === program);

Then('no command was run', (world) => {
  expect(calls(world)).toHaveLength(0);
});

Then('exactly these commands were run:', (world, table: DataTable) => {
  expect(calls(world).map(({ command }) => command)).toEqual(
    table.list().map((line) => line.split(' '))
  );
});

Then('only these programs were run:', (world, table: DataTable) => {
  const programs = table.list();
  expect(
    calls(world).every(({ command }) => programs.includes(command[0]!))
  ).toBe(true);
});

Then('the program {string} was not run', (world, program: string) => {
  expect(over(world, program)).toHaveLength(0);
});

Then(
  'the program {string} was run {int} time(s)',
  (world, program: string, count: number) => {
    expect(over(world, program)).toHaveLength(count);
  }
);

Then(
  'a command with the argument {string} was run {int} time(s)',
  (world, argument: string, count: number) => {
    expect(
      calls(world).filter(({ command }) => command.includes(argument))
    ).toHaveLength(count);
  }
);

Then(
  'no command that was run has the argument {string}',
  (world, argument: string) => {
    expect(calls(world).flatMap(({ command }) => command)).not.toContain(
      argument
    );
  }
);

Then(
  'every command that was run has the argument {string}',
  (world, argument: string) => {
    for (const { command } of calls(world)) expect(command).toContain(argument);
  }
);

Then('no command that was run starts with {string}', (world, line: string) => {
  const start = line.split(' ');
  expect(
    calls(world).some(({ command }) =>
      start.every((argument, index) => command[index] === argument)
    )
  ).toBe(false);
});

Then('{int} command(s) was/were run over SSH', (world, count: number) => {
  expect(over(world, 'ssh')).toHaveLength(count);
});

Then(
  'every command run over SSH was given the probe {string}',
  (world, source: string) => {
    for (const { input } of over(world, 'ssh')) expect(input).toBe(source);
  }
);

Then('no probe was bundled for workers', (world) => {
  expect(machine(world).bundled).toBe(0);
});

// ── What workers were asked ──────────────────────────────────────────────

const repairs = (world: CliWorld) =>
  machine(world).requests.filter((asked) => asked['action'] === 'repair');

Then('workers were asked to repair {int} time(s)', (world, count: number) => {
  expect(repairs(world)).toHaveLength(count);
});

Then('workers were probed {int} time(s)', (world, count: number) => {
  expect(
    machine(world).requests.filter((asked) => asked['action'] !== 'repair')
  ).toHaveLength(count);
});

Then(
  'each repair a worker was asked for holds at least:',
  (world, document: string) => {
    for (const asked of repairs(world))
      expect(asked).toMatchObject(json(document) as Record<string, unknown>);
  }
);

Then(
  'each repair a worker was asked for expects the fingerprint the worker reported',
  (world) => {
    for (const asked of repairs(world))
      expect(asked).toMatchObject({
        expected: machine(world).snapshot!.fingerprint,
      });
  }
);

Then(
  'every request to a worker names the workspace {string}',
  (world, workspace: string) => {
    for (const asked of machine(world).requests)
      expect(at(asked, 'node.workspace')).toBe(workspace);
  }
);

// ── The report ───────────────────────────────────────────────────────────

const report = (world: CliWorld): Report => outcome(world).data as Report;

Then('the report covers exactly {string}', (world, nodes: string) => {
  expect(report(world).nodes.map((node) => node.node)).toEqual(listed(nodes));
});

Then('the report covers {string}', (world, node: string) => {
  expect(report(world).nodes.some((entry) => entry.node === node)).toBe(true);
});

Then(
  'the check {string} of {string} has the status {string}',
  (world, id: string, node: string, status: string) => {
    expect<string | undefined>(
      report(world)
        .nodes.find((entry) => entry.node === node)
        ?.checks.find((check) => check.id === id)?.status
    ).toBe(status);
  }
);

Then(
  'the check {string} has the status {string}',
  (world, id: string, status: string) => {
    expect(
      report(world)
        .nodes.flatMap((node) => node.checks)
        .some((check) => check.id === id && check.status === status)
    ).toBe(true);
  }
);

// ── The manager's schedule, as the fleet state records it ────────────────

Given(
  'the fleet state records a schedule turned on at {string}, every {int} minutes, that never succeeded',
  async (world, at: string, minutes: number) => {
    const before = process.env['DEVFLEET_STATE'];
    process.env['DEVFLEET_STATE'] = await temporary(world, 'fleet-schedule-');
    world.defer(() => {
      process.env['DEVFLEET_STATE'] = before;
    });
    recordSchedule({
      enabled: true,
      intervalSeconds: minutes * 60,
      changedAt: at,
    });
  }
);
