import { expect } from 'bun:test';
import type { DataTable } from '../../support/gherkin';
import { runCommand } from '../../../src/runner';
import {
  remoteCommand,
  shellQuote,
  sshArgs,
  sshFailure,
} from '../../../src/ssh';
import { bundleProbe, inspectRemote } from '../../../src/transport';
import type { CommandResult } from '../../../src/types';
import { core, need, type CoreWorld } from './world';
import { worker } from './t3';

/** The SSH command the manager builds, what it sends and what it makes of a
 * session that failed.
 */
const { Given, When, Then } = core;

const argv = (world: CoreWorld): string[] =>
  need(world, world.argv, 'a command');

When('the SSH command for the worker is built', (world) => {
  world.argv = sshArgs(worker(world));
  world.text = world.argv.join(' ');
});

When('the command that probes the worker over SSH is built', (world) => {
  world.argv = remoteCommand(worker(world), { action: 'probe' });
});

Then('it has each of these arguments:', (world, table: DataTable) => {
  for (const argument of table.list()) expect(argv(world)).toContain(argument);
});

Then('its last argument is {string}', (world, argument: string) => {
  expect(argv(world).at(-1)).toBe(argument);
});

Then(
  'its last argument contains the workspace, quoted as:',
  (world, quoted: string) => {
    expect(shellQuote(worker(world).workspace)).toBe(quoted);
    expect(argv(world).at(-1)).toContain(quoted);
  }
);

When(
  'a POSIX shell prints the path {string}, quoted',
  async (world, path: string) => {
    // A real shell is the judge of what a quoted path means to a shell.
    world.result = await runCommand([
      'sh',
      '-c',
      `printf '%s' ${shellQuote(path)}`,
    ]);
  }
);

const REASONS: Record<string, CommandResult['reason']> = {
  failed: 'exit',
  'ran out of time': 'timeout',
  'could not be started': 'missing',
};

Given(
  /^an SSH session that (failed|ran out of time|could not be started)(?:, printing:)?$/,
  (world, ended: string, stderr = '') => {
    world.result = {
      ok: false,
      stdout: '',
      stderr: String(stderr),
      reason: REASONS[ended]!,
    };
  }
);

When('the failed session is classified', (world) => {
  const check = sshFailure(need(world, world.result, 'an SSH session'));
  world.checks = [check];
  world.outcome = check;
});

When('the worker is probed over SSH', async (world) => {
  const report = await inspectRemote(
    worker(world),
    { source: '', action: 'probe', timeoutMs: 1000 },
    world.commands.run
  );
  world.checks = report.checks;
  world.outcome = report;
});

When('the probe is bundled', async (world) => {
  world.text = await bundleProbe();
});

Then('it imports no relative path', (world) => {
  expect(need(world, world.text, 'a probe')).not.toMatch(/from["']\.\.?\//);
});
