import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import {
  toolChecks,
  type Check as DoctorCheck,
  type Runner as DoctorRunner,
} from '../../../bootstrap/doctor';
import {
  workerSelection,
  workerToolset,
} from '../../../bootstrap/worker-tools';
import { toolchainChecks } from '../../../src/toolchain-checks';
import { parseDefinition } from '../../../src/definition';
import { core, need, root, type CoreWorld } from './world';

/** Which tools a worker installs, and how the doctor checks them. */
const { Given, When, Then } = core;

type Tool = string | { version: string; lazy?: boolean; os?: string[] };
const mise = Bun.TOML.parse(
  readFileSync(resolve(root, 'mise.toml'), 'utf8')
) as { tools: Record<string, Tool>; vars: Record<string, unknown> };
const lock = readFileSync(resolve(root, 'mise.lock'), 'utf8');
const pin = (tool: Tool): string =>
  typeof tool === 'string' ? tool : tool.version;
const base = (mise.vars['worker_tools'] as string).split(',');

interface Doctor {
  printed: Map<string, string>;
  pinnedOnly: boolean;
  checks: DoctorCheck[];
}
const doctors = new WeakMap<CoreWorld, Doctor>();
function doctor(world: CoreWorld): Doctor {
  let found = doctors.get(world);
  if (!found) {
    found = { printed: new Map(), pinnedOnly: false, checks: [] };
    doctors.set(world, found);
  }
  return found;
}

/** The commands the doctor runs, by the name of the command. */
const COMMANDS: Record<string, string> = {
  rustc: 'rust',
  yarn: 'npm:@yarnpkg/cli-dist',
};
function runner(world: CoreWorld): DoctorRunner {
  return ([command]) => {
    const printed = doctor(world).printed.get(command!);
    if (printed !== undefined) return { ok: true, output: printed };
    const tool = mise.tools[COMMANDS[command!] ?? command!];
    return doctor(world).pinnedOnly && tool
      ? { ok: true, output: pin(tool) }
      : { ok: false, output: '' };
  };
}

Then(
  'the tool profile {string} adds {string}',
  (_world, profile: string, tools: string) => {
    expect(mise.vars[`worker_profile_${profile}`]).toBe(tools);
  }
);

Then(
  'every tool of the profile {string} is pinned in mise.toml and locked in mise.lock',
  (_world, profile: string) => {
    const tools = String(mise.vars[`worker_profile_${profile}`]).split(',');
    for (const tool of tools) {
      expect(Object.hasOwn(mise.tools, tool)).toBe(true);
      expect(lock).toContain(
        /^[a-z0-9-]+$/.test(tool) ? `[[tools.${tool}]]` : `[[tools."${tool}"]]`
      );
    }
  }
);

function toolsOf(world: CoreWorld, id: string): string[] {
  const definition = need(world, world.definition, 'a fleet configuration');
  return Object.keys(
    workerToolset(mise.tools, mise.vars, workerSelection(definition, id))
  );
}

Then(
  'the worker {string} installs the base tools, then these:',
  (world, id: string, table: DataTable) => {
    const added = table.list().filter((tool) => tool !== '(none)');
    expect(toolsOf(world, id)).toEqual([...base, ...added]);
  }
);

Then(
  'choosing the tools of the worker {string} is refused with {string}',
  (world, id: string, text: string) => {
    expect(() => toolsOf(world, id)).toThrow(text);
  }
);

When(
  'the toolchain of the worker {string} in the checkout at {string} is checked',
  async (world, id: string, checkout: string) => {
    const definition = parseDefinition(
      need(world, world.written, 'a fleet configuration')
    );
    world.checks = await toolchainChecks(
      checkout,
      world.commands.run,
      workerSelection(definition, id)
    );
    world.outcome = world.checks;
  }
);

Then('the doctor was run with {string}', (world, argv: string) => {
  const doctorRuns = world.commands
    .ran('bootstrap/doctor.ts')
    .map((command) => command.join(' '));
  expect(doctorRuns).toHaveLength(1);
  expect(doctorRuns[0]).toEndWith(argv);
});

Given('every tool prints the version mise.toml pins for it', (world) => {
  doctor(world).pinnedOnly = true;
});

Given(
  'the tool command {string} prints {string}',
  (world, command: string, output: string) => {
    doctor(world).printed.set(command, output);
  }
);

When(
  'the doctor checks a worker with the profiles {string}',
  (world, profiles: string) => {
    const tools = workerToolset(mise.tools, mise.vars, {
      profiles: profiles.split(','),
      tools: [],
    });
    const eager = Object.fromEntries(
      Object.entries(tools).map(([id, tool]) => [
        id,
        typeof tool === 'string' ? tool : { ...tool, lazy: false },
      ])
    );
    doctor(world).checks = toolChecks(eager, runner(world), 'linux');
  }
);

When(
  'the doctor checks the tool {string} pinned at {string}',
  (world, tool: string, version: string) => {
    doctor(world).checks = toolChecks(
      { [tool]: version },
      runner(world),
      'linux'
    );
  }
);

Then(
  "the doctor's checks include, each passing:",
  (world, table: DataTable) => {
    for (const id of table.list())
      expect(
        doctor(world).checks.find((check) => check.id === id)?.status
      ).toBe('pass');
  }
);

Then("the doctor's check {string} passes", (world, id: string) => {
  expect(doctor(world).checks.find((check) => check.id === id)?.status).toBe(
    'pass'
  );
});
