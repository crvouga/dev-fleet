import { expect } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  ansibleCommand,
  runAnsible,
  variablesDirectory,
} from '../../../src/platform/ansible';
import { runAnsibleWithReceipt } from '../../../src/platform/ansible-receipt';
import { failed, succeeded } from '../../support/commands';
import type { DataTable } from '../../support/gherkin';
import { machines, temporary, type AnsibleRun } from './world';
import type { MachinesWorld } from './world';

const { Given, When, Then } = machines;

// ── One run ──────────────────────────────────────────────────────────────

Given('a private run directory', async (world) => {
  world.directory = join(await temporary(world, 'ansible-run-'), 'run');
});

Given('Ansible is interrupted with the error {string}', (world, message) => {
  world.interruption = String(message);
});

When(
  'the playbook {string} is run with the variables:',
  async (world, playbook: string, variables: string) => {
    // Ansible is answered here, where the variables file can still be read.
    world.commands.answer(
      () => true,
      async (command, options) => {
        const argument = command.at(-1)!;
        const path = argument.slice(1);
        world.ansible = { argument, path, input: options?.input };
        if (world.interruption !== undefined)
          throw new Error(world.interruption);
        world.ansible.fileMode = (await stat(path)).mode & 0o777;
        world.ansible.directoryMode = (await stat(dirname(path))).mode & 0o777;
        world.ansible.content = await readFile(path, 'utf8');
        return succeeded();
      }
    );
    await world.attempt(async () => {
      await runAnsible(
        world.run,
        playbook,
        { input: variables },
        world.directory
      );
    });
  }
);

/** What Ansible was started with; a run that never reached it is an error. */
function started(world: MachinesWorld): AnsibleRun {
  if (!world.ansible) throw world.failure ?? new Error('Ansible never ran.');
  return world.ansible;
}

/** The same, for a scenario in which the run was expected to succeed. */
function ran(world: MachinesWorld): AnsibleRun {
  if (world.failure !== undefined) throw world.failure;
  return started(world);
}

const missing = (path: string): Promise<boolean> =>
  stat(path).then(
    () => false,
    () => true
  );

Then(
  'the last argument of Ansible was {string} and the path of a variables file',
  (world, prefix: string) => {
    expect(ran(world).argument).toBe(prefix + ran(world).path);
    expect(basename(ran(world).path)).toBe('variables.json');
  }
);

Then('Ansible was given nothing on standard input', (world) => {
  expect(ran(world).input).toBeUndefined();
});

Then(
  'while Ansible ran, the variables file had the mode {string}',
  (world, mode: string) => {
    expect(ran(world).fileMode?.toString(8)).toBe(mode);
  }
);

Then(
  'while Ansible ran, the directory of the variables file had the mode {string}',
  (world, mode: string) => {
    expect(ran(world).directoryMode?.toString(8)).toBe(mode);
  }
);

Then(
  'while Ansible ran, the variables file held the {string} {string}',
  (world, key: string, value: string) => {
    const variables = JSON.parse(ran(world).content ?? '') as Record<
      string,
      unknown
    >;
    expect(variables[key]).toBe(value);
  }
);

Then(
  'the variables file was in a directory of its own in the run directory',
  (world) => {
    expect(dirname(dirname(ran(world).path))).toBe(world.directory);
  }
);

Then('the variables file is gone', async (world) => {
  expect(await missing(ran(world).path)).toBe(true);
});

Then('the directory of the variables file is gone', async (world) => {
  expect(await missing(dirname(started(world).path))).toBe(true);
});

Then(
  'the variables of a machine whose home is {string} are kept in {string}',
  (_world, home: string, directory: string) => {
    expect(variablesDirectory(home)).toBe(directory);
  }
);

Then(
  'on {string}, with the package at {string}, a playbook is run with {string}',
  (_world, platform: string, root: string, command: string) => {
    expect(ansibleCommand(platform as NodeJS.Platform, root)).toEqual(
      command.split(' ')
    );
  }
);

// ── Applies recorded by a receipt ────────────────────────────────────────

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

Given(
  'a playbook {string} with these sources:',
  async (world, playbook: string, table: DataTable) => {
    const root = await temporary(world, 'ansible-receipt-');
    world.playbook = playbook;
    world.sources = join(root, 'playbooks');
    world.receipts = join(root, 'receipts');
    for (const row of table.hashes())
      await write(join(world.sources, row['file']!), row['content']!);
  }
);

Given(
  'its applies are recorded in the receipt {string}',
  (world, file: string) => {
    world.receipt = basename(file, '.json');
  }
);

Given(/^Ansible (?:now )?(succeeds|fails)$/, (world, outcome: string) => {
  world.otherwise = outcome === 'succeeds' ? succeeded() : failed();
});

Given(
  /^the postcondition of the playbook (holds|no longer holds)$/,
  (world, state: string) => {
    world.verified = state === 'holds';
  }
);

Given(
  'the source {string} now holds {string}',
  async (world, file: string, content: string) => {
    await write(join(world.sources, file), content);
  }
);

Given(
  'the sources of the playbook are in a directory that does not exist',
  (world) => {
    world.sources = join(dirname(world.sources), 'absent');
  }
);

const HOUR_MS = 60 * 60 * 1000;

// The same step sets a situation up ("was applied") and is what happens
// ("is applied").
When(
  /^the playbook (?:was|is) applied with the variables '([^']*)'(?:, (by force|\d+ hours later))?$/,
  async (world, variables: string, how: string | null | undefined) => {
    const hours = /^(\d+) hours later$/.exec(how ?? '')?.[1];
    world.applied = await runAnsibleWithReceipt(
      world.run,
      world.playbook,
      { input: variables },
      {
        name: world.receipt,
        sources: [world.sources],
        directory: world.receipts,
        verify: async () => world.verified,
        ...(hours ? { now: Date.now() + Number(hours) * HOUR_MS } : {}),
        ...(how === 'by force' ? { force: true } : {}),
      }
    );
  }
);

Then(/^the playbook (ran|was skipped)$/, (world, outcome: string) => {
  expect(world.applied?.cached).toBe(outcome === 'was skipped');
});

Then('the apply failed', (world) => {
  expect(world.applied?.ok).toBe(false);
});

Then('Ansible ran {int} time(s) in all', (world, count: number) => {
  expect(world.commands.calls).toHaveLength(count);
});

Then(
  'the receipt {string} does not contain {string}',
  async (world, file: string, text: string) => {
    expect(await readFile(join(world.receipts, file), 'utf8')).not.toContain(
      text
    );
  }
);
