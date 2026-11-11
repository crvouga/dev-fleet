import { expect } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../../src/runner';
import type { CommandResult } from '../../../src/types';
import { need, orchestration, type OrchestrationWorld } from '../support/world';

const { Given, When, Then } = orchestration;

const cli = fileURLToPath(new URL('../../../src/cli/cli.ts', import.meta.url));

/** Runs the real CLI in the scenario's directory, as `devfleet …` would. */
async function devfleet(
  world: OrchestrationWorld,
  line: string
): Promise<CommandResult> {
  const [name, ...args] = line.split(' ');
  if (name !== 'devfleet') throw new Error(`Not a devfleet command: ${line}`);
  return runCommand([process.execPath, cli, ...args], {
    cwd: need(world.root, 'a directory'),
  });
}

Given('the operator has run {string}', async (world, line: string) => {
  const result = await devfleet(world, line);
  if (!result.ok) throw new Error(`The command failed: ${line}`);
});

When('the operator runs {string}', async (world, line: string) => {
  const root = need(world.root, 'a directory');
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isFile())
      world.cli.before.set(
        entry.name,
        await readFile(join(root, entry.name), 'utf8')
      );
  world.process = await devfleet(world, line);
});

const ran = (world: OrchestrationWorld): CommandResult =>
  need(world.process, 'a process that ran');
/** What the process printed, read as the JSON document it should be. */
const answer = (world: OrchestrationWorld): Record<string, unknown> =>
  JSON.parse(ran(world).stdout) as Record<string, unknown>;
const firstWorker = (world: OrchestrationWorld): Record<string, unknown> =>
  need(
    (answer(world)['nodes'] as Record<string, unknown>[] | undefined)?.[0],
    'a first worker in the answer'
  );

Then(/^the process (succeeds|fails)$/, (world, outcome: string) => {
  expect(ran(world).ok).toBe(outcome === 'succeeds');
});

Then('it prints a JSON object', (world) => {
  expect(answer(world)).toBeObject();
});

Then('it prints nothing to its error output', (world) => {
  expect(ran(world).stderr).toBe('');
});

Then(
  /^the answer says "([^"]+)" is (true|false|"[^"]*")$/,
  (world, field: string, value: string) => {
    expect(answer(world)[field]).toBe(JSON.parse(value));
  }
);

Then(
  /^the first worker in the answer says "([^"]+)" is (true|false|"[^"]*")$/,
  (world, field: string, value: string) => {
    expect(firstWorker(world)[field]).toBe(JSON.parse(value));
  }
);

Then(
  'the {string} of the first worker in the answer contains {string}',
  (world, field: string, text: string) => {
    expect(firstWorker(world)[field]).toContain(text);
  }
);

Then(
  '{string} appears nowhere in what the process printed',
  (world, text: string) => {
    expect(`${ran(world).stdout}${ran(world).stderr}`).not.toContain(text);
  }
);

Then('the file {string} does not exist', async (world, name: string) => {
  expect(
    await Bun.file(join(need(world.root, 'a directory'), name)).exists()
  ).toBe(false);
});

Then(
  'the file {string} is a roster of version {int}',
  async (world, name: string, version: number) => {
    const contents = await readFile(
      join(need(world.root, 'a directory'), name),
      'utf8'
    );
    expect((JSON.parse(contents) as { version: unknown }).version).toBe(
      version
    );
  }
);

Then(
  'the file {string} is as it was before the command',
  async (world, name: string) => {
    expect(
      await readFile(join(need(world.root, 'a directory'), name), 'utf8')
    ).toBe(need(world.cli.before.get(name), `"${name}" before the command`));
  }
);
