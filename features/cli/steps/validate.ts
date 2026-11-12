import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import example from '../../../examples/fleet.json';
import { fleetValidate } from '../../../src/cli/fleet-validate';
import { PACKAGE_ROOT } from '../../../src/package-info';
import { Commands, failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { attempt, cli, json, part, put, type CliWorld } from './world';

/** fleet-validate and the pinned Ansible it may run. */
const { Given, When, Then } = cli;

const validation = part(() => ({
  document: structuredClone(example) as unknown,
  commands: new Commands(),
  /** The inventory each `ansible-inventory` call was given, as it read. */
  inventories: [] as unknown[],
}));

const file = (world: CliWorld): string =>
  join(world.names['PROJECT']!, 'fleet.json');

async function save(world: CliWorld): Promise<void> {
  await writeFile(file(world), JSON.stringify(validation(world).document));
}

Given('the project holds the example fleet configuration', (world) =>
  save(world)
);

Given(
  /^in the project's fleet configuration, "([^"]+)" is (.+)$/,
  async (world, path: string, value: string) => {
    put(validation(world).document, path, json(value));
    await save(world);
  }
);

Given(
  "the project's fleet configuration holds {string}",
  async (world, text: string) => {
    await writeFile(file(world), text);
  }
);

function ansible(world: CliWorld, refused?: string): void {
  const { commands, inventories } = validation(world);
  commands.answer(
    (command) => command.includes('ansible-inventory'),
    (command) => {
      const path = command[command.indexOf('-i') + 1]!;
      inventories.push(JSON.parse(readFileSync(path, 'utf8')));
      return succeeded('{}');
    }
  );
  commands.answer(
    (command) => command.includes('--syntax-check'),
    (command) =>
      refused && command.at(-1)!.endsWith(refused) ? failed() : succeeded()
  );
}

Given('the pinned Ansible accepts everything', (world) => ansible(world));

Given(
  'the pinned Ansible refuses the syntax of {string}',
  (world, playbook: string) => ansible(world, playbook)
);

When(
  "the operator validates the project's fleet configuration with Ansible",
  async (world) => {
    world.outcome = await attempt(world, () =>
      fleetValidate(
        { file: file(world), ansible: true, json: true },
        {
          run: validation(world).commands.run,
          env: {},
          platform: 'linux',
          root: PACKAGE_ROOT,
        }
      )
    );
  }
);

Then(
  'the inventory Ansible listed has the hosts:',
  (world, table: DataTable) => {
    const [inventory] = validation(world).inventories as {
      all: { children: Record<string, { hosts: Record<string, unknown> }> };
    }[];
    const listed = Object.entries(inventory!.all.children).flatMap(
      ([group, { hosts }]) =>
        Object.keys(hosts).map((host) => ({ group, host }))
    );
    expect<object[]>(listed).toEqual(table.hashes());
  }
);

Then(
  'Ansible checked the syntax of every playbook under {string} and {string}',
  async (world, first: string, second: string) => {
    const expected: string[] = [];
    for (const directory of [first, second])
      for (const entry of await readdir(join(PACKAGE_ROOT, directory)))
        if (entry.endsWith('.yml'))
          expected.push(join(PACKAGE_ROOT, directory, entry));
    const checked = validation(world)
      .commands.ran('--syntax-check')
      .map((command) => command.at(-1)!);
    expect(checked.sort()).toEqual(expected.sort());
  }
);

Then('no command reached another machine', (world) => {
  const programs = validation(world).commands.calls.map(
    (call) => call.command[0]
  );
  expect(programs.length).toBeGreaterThan(0);
  for (const program of programs)
    expect(['ssh', 'scp', 'curl', 'tailscale']).not.toContain(program);
});
