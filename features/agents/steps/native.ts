import { expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rewriteAuthenticate } from '../../../src/agents/launch';
import {
  NATIVE_AGENTS,
  parsePins,
  verifyNativeAgents,
} from '../../../src/agents/native-verify';
import type { VerifyCache } from '../../../src/agents/verify-cache';
import type { Check } from '../../../src/types';
import { Commands, failed, succeeded } from '../../support/commands';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type AgentsWorld } from './world';

export const native = steps<AgentsWorld>();
const { Given, When, Then } = native;

const checkout = resolve(import.meta.dir, '../../..');
const pinned = async (): Promise<Record<string, string>> =>
  parsePins(await readFile(resolve(checkout, 'mise.toml'), 'utf8'));

const isVersion = (command: string[]): boolean => command[1] === '--version';
const isReinstall = (command: string[]): boolean => command[0] === 'mise';
const isLaunch = (command: string[]): boolean => command[0] === 'bun';
const launches =
  (launcher: string) =>
  (command: string[]): boolean =>
    isLaunch(command) && Boolean(command[1]?.endsWith(launcher));
const agentOf = (binary: string | undefined) => {
  const agent = NATIVE_AGENTS.find((entry) => entry.binary === binary);
  if (!agent) throw new Error(`T3 offers no agent run as ${binary}.`);
  return agent;
};

const machine = part(() => ({
  pins: {} as Record<string, string>,
  // mise reinstalls whatever it is asked to; every other command is scripted
  // by the scenario.
  commands: new Commands().answer(isReinstall, succeeded()),
  cache: undefined as VerifyCache | undefined,
  outOfQuota: new Set<string>(),
  checks: [] as Check[],
}));

// ── Pins ─────────────────────────────────────────────────────────────────

When('the pins of mise.toml are read', async (world) => {
  machine(world).pins = await pinned();
});

Then('every agent T3 offers is pinned:', (world, table: DataTable) => {
  expect(table.hashes()).toEqual(
    NATIVE_AGENTS.map(({ name, pin }) => ({ agent: name, pin }))
  );
  for (const { pin } of NATIVE_AGENTS)
    expect(machine(world).pins[pin]).toBeTruthy();
});

Then(
  '{string} is pinned to {string}',
  (world, pin: string, version: string) => {
    expect(machine(world).pins[pin]).toBe(version);
  }
);

Then('{string} is pinned to a release number', (world, pin: string) => {
  expect(machine(world).pins[pin]).toMatch(/^\d+\.\d+\.\d+$/);
});

// ── A machine's agents ───────────────────────────────────────────────────

Given('nothing verified earlier is remembered', (world) => {
  // Unwritable: nothing is read from it and nothing can be recorded in it.
  machine(world).cache = { directory: '/dev/null/verify' };
});

Given('every agent reports the version mise.toml pins', async (world) => {
  const pins = await pinned();
  machine(world).commands.answer(isVersion, (command) =>
    succeeded(`tool ${pins[agentOf(command[0]).pin]}\n`)
  );
});

Given('every agent reports the version {string}', (world, version: string) => {
  machine(world).commands.answer(isVersion, succeeded(`tool ${version}`));
});

Given(
  '{string} reports the version {string} until it is reinstalled',
  async (world, name: string, version: string) => {
    const agent = NATIVE_AGENTS.find((entry) => entry.name === name)!;
    const pins = await pinned();
    let reinstalled = false;
    machine(world)
      .commands.answer(isReinstall, () => {
        reinstalled = true;
        return succeeded();
      })
      .answer(
        (command) => isVersion(command) && command[0] === agent.binary,
        () => succeeded(reinstalled ? `v ${pins[agent.pin]}` : version)
      );
  }
);

Given('every launcher answers {string}', (world, answer: string) => {
  machine(world).commands.answer(isLaunch, succeeded(`${answer}\n`));
});

Given(
  'the {string} launcher fails with:',
  (world, launcher: string, output: string) => {
    machine(world).commands.answer(launches(launcher), failed(output));
  }
);

Given(
  'the {string} launcher fails the first time it is run and then answers {string}',
  (world, launcher: string, answer: string) => {
    let runs = 0;
    machine(world).commands.answer(launches(launcher), () =>
      ++runs > 1 ? succeeded(answer) : failed()
    );
  }
);

Given('the shared {string} account is out of quota', (world, name: string) => {
  machine(world).outOfQuota.add(name);
});

When(
  'the agents of the machine {string} are verified',
  async (world, id: string) => {
    const { cache, commands, outOfQuota } = machine(world);
    if (!cache)
      throw new Error('Say what is remembered of earlier verification.');
    machine(world).checks = await verifyNativeAgents(
      id,
      checkout,
      commands.run,
      { outOfQuota, cache }
    );
  }
);

const check = (world: AgentsWorld, id: string): Check => {
  const found = machine(world).checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`There is no check ${id}.`);
  return found;
};
const launchers = (world: AgentsWorld): string[] =>
  machine(world)
    .commands.ran(isLaunch)
    .map((command) => String(command[1]?.split('/').pop()))
    .sort();

Then(
  'there are {int} checks: a version check and a session check for each agent',
  (world, count: number) => {
    expect(machine(world).checks).toHaveLength(count);
    expect(count).toBe(NATIVE_AGENTS.length * 2);
  }
);

Then('every check passes', (world) => {
  const { checks } = machine(world);
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.filter((entry) => entry.status !== 'pass')).toEqual([]);
});

Then('exactly these launchers were run:', (world, table: DataTable) => {
  expect(launchers(world)).toEqual(table.list().sort());
  expect(launchers(world)).toEqual(
    NATIVE_AGENTS.map((agent) => agent.wrapper).sort()
  );
});

Then(
  'the check {string} reports {string}',
  (world, id: string, summary: string) => {
    expect(check(world, id).summary).toBe(summary);
  }
);

Then(
  'the remedy of the check {string} mentions {string}',
  (world, id: string, text: string) => {
    expect(check(world, id).remedy?.action ?? '').toContain(text);
  }
);

Then('the check {string} passes', (world, id: string) => {
  expect(check(world, id).status).toBe('pass');
});

Then('no check contains {string}', (world, text: string) => {
  expect(JSON.stringify(machine(world).checks)).not.toContain(text);
});

Then(
  'the only reinstall was of {string}, at the version mise.toml pins',
  async (world, pin: string) => {
    const pins = await pinned();
    expect(
      machine(world)
        .commands.ran(isReinstall)
        .map((command) => command.at(-1))
    ).toEqual([`${pin}@${pins[pin]}`]);
  }
);

Then('the {string} launcher was not run', (world, launcher: string) => {
  expect(machine(world).commands.ran(launches(launcher))).toEqual([]);
});

Then(
  'the {string} launcher was run {int} times',
  (world, launcher: string, count: number) => {
    expect(machine(world).commands.ran(launches(launcher))).toHaveLength(count);
  }
);

// ── Antigravity's sign-in ────────────────────────────────────────────────

const signIn = part(() => ({ sent: '', received: '' }));

When('T3 sends Antigravity the message:', (world, message: string) => {
  signIn(world).sent = message;
  signIn(world).received = rewriteAuthenticate(message);
});

Then('Antigravity receives:', (world, message: string) => {
  expect(JSON.parse(signIn(world).received)).toEqual(JSON.parse(message));
});

Then('Antigravity receives the message unchanged', (world) => {
  expect(signIn(world).received).toBe(signIn(world).sent);
});
