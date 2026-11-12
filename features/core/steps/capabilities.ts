import { expect } from 'bun:test';
import type { GitIdentity } from '../../../src/definition';
import { gitChecks } from '../../../src/git-identity';
import {
  browserCheck,
  dockerRunCheck,
} from '../../../src/worker-capability-checks';
import type { Check } from '../../../src/types';
import { control, core, startsWith, type CoreWorld } from './world';

/** A worker trying what agents do: containers, a browser, Git. */
const { Given, When, Then } = core;

const identities = new WeakMap<CoreWorld, GitIdentity | undefined>();

function reported(world: CoreWorld, checks: Check[]): void {
  world.checks = checks;
  world.outcome = checks;
}

Given('every command could not be started', (world) => {
  world.commands.otherwise = {
    ok: false,
    stdout: '',
    stderr: '',
    reason: 'missing',
  };
});

Given('every command ran out of time', (world) => {
  world.commands.otherwise = {
    ok: false,
    stdout: '',
    stderr: '',
    reason: 'timeout',
  };
});

Given(
  /^the fleet declares the Git identity "([^"]+)" <([^>]+)>$/,
  (world, name: string, email: string) => {
    identities.set(world, { name, email });
  }
);

Given(
  'the fleet declares that pushes are proven against {string}',
  (world, repository: string) => {
    const git = identities.get(world);
    if (!git) throw new Error('No step has declared a Git identity yet.');
    identities.set(world, { ...git, verifyRepository: repository });
  }
);

Given('the fleet declares no Git identity', (world) => {
  identities.set(world, undefined);
});

When("the worker's Docker is tried", async (world) => {
  reported(world, [await dockerRunCheck(world.commands.run)]);
});

When("the worker's browser is tried without the web profile", async (world) => {
  reported(world, [await browserCheck(world.commands.run, false)]);
});

When(
  "the worker's browser is tried with the web profile on {string}",
  async (world, arch: string) => {
    reported(world, [await browserCheck(world.commands.run, true, arch)]);
  }
);

When("the worker's Git is checked", async (world) => {
  reported(world, await gitChecks(identities.get(world), world.commands.run));
});

Then(
  'the command {string} was given {string} on standard input',
  (world, line: string, input: string) => {
    const matches = startsWith(line);
    const calls = world.commands.calls.filter((call) => matches(call.command));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.options?.input).toBe(control(input));
  }
);

Then(
  "every {string} command ran with git's prompts turned off",
  (world, name: string) => {
    const calls = world.commands.calls.filter(
      (call) => call.command[0] === name && call.command[1] !== 'config'
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls)
      expect(call.options?.env?.['GIT_TERMINAL_PROMPT']).toBe('0');
  }
);
