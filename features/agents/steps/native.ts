import { expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { render } from '../../../src/agents/render';
import { select } from '../../../src/agents/registry';
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
/** The launcher a command starts: through Bun, or run directly as T3 runs
 * its binaryPath.
 */
const launcherOf = (command: string[]): string | undefined => {
  const path = command[0] === 'bun' ? command[1] : command[0];
  return path?.includes('/agents/') ? path.split('/').pop() : undefined;
};
const isLaunch = (command: string[]): boolean =>
  launcherOf(command) !== undefined;
const launches =
  (launcher: string) =>
  (command: string[]): boolean =>
    launcherOf(command) === launcher;
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
  /** Whether sessions run where T3 runs them, in its service's environment. */
  service: false,
  outOfQuota: new Set<string>(),
  checks: [] as Check[],
  /** Where the agent profiles are rendered; none unless a step says so. */
  profiles: '/dev/null/profiles',
  /** Commands already run before the step that is observed. */
  before: 0,
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
    machine(world).checks = await verify(world, id);
  }
);

async function verify(world: AgentsWorld, id: string): Promise<Check[]> {
  const { cache, commands, outOfQuota, profiles } = machine(world);
  if (!cache)
    throw new Error('Say what is remembered of earlier verification.');
  return verifyNativeAgents(id, checkout, commands.run, {
    outOfQuota,
    cache,
    t3Service: machine(world).service,
    profiles,
  });
}

Given('verified sessions are remembered', async (world) => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-cache-'));
  world.defer(() => rm(directory, { recursive: true, force: true }));
  machine(world).cache = { directory };
});

Given(
  'the agent profiles of the machine {string} are rendered',
  async (world, node: string) => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-profiles-'));
    world.defer(() => rm(directory, { recursive: true, force: true }));
    machine(world).profiles = directory;
    for (const tool of new Set(NATIVE_AGENTS.map((agent) => agent.binary)))
      for (const [name, content] of Object.entries(
        render(select(node, tool, 'proxy'))
      )) {
        const path = join(directory, node, tool, 'proxy', name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
  }
);

Given(
  'the agents of the machine {string} have been verified once',
  async (world, id: string) => {
    await verify(world, id);
    machine(world).before = machine(world).commands.calls.length;
  }
);

Given(
  'the {string} profile of the machine {string} now holds something else',
  async (world, tool: string, node: string) => {
    const directory = join(machine(world).profiles, node, tool, 'proxy');
    const [name] = Object.keys(render(select(node, tool, 'proxy')));
    await writeFile(join(directory, name!), 'edited by hand\n');
  }
);

const launchedAgain = (world: AgentsWorld): string[] =>
  machine(world)
    .commands.calls.slice(machine(world).before)
    .map((call) => call.command)
    .filter(isLaunch)
    .map((command) => String(launcherOf(command)));

Then('no launcher was run again', (world) => {
  expect(launchedAgain(world)).toEqual([]);
});

Then('only the launcher {string} was run again', (world, launcher: string) => {
  expect(launchedAgain(world)).toEqual([launcher]);
});

// ── The environment of the T3 service ────────────────────────────────────

const isShow = (command: string[]): boolean =>
  command[0] === 'systemctl' && command[2] === 'show';
const isManagerEnvironment = (command: string[]): boolean =>
  command[0] === 'systemctl' && command[2] === 'show-environment';
const isBunLookup = (command: string[]): boolean =>
  command[0] === '/bin/sh' && command.at(-1) === 'command -v bun';

Given(
  'the agents run where T3 runs them, on a worker whose user service manager holds:',
  (world, table: DataTable) => {
    machine(world).service = true;
    machine(world).commands.answer(
      isManagerEnvironment,
      succeeded(
        Object.entries(table.rowsHash())
          .map(([name, value]) => `${name}=${value}\n`)
          .join('')
      )
    );
  }
);

Given('the T3 service adds {string}', (world, environment: string) => {
  machine(world).commands.answer(isShow, succeeded(`${environment}\n`));
});

Given(/^Bun is (found|not found) on that PATH$/, (world, found: string) => {
  machine(world).commands.answer(
    isBunLookup,
    found === 'found' ? succeeded('/somewhere/bun\n') : failed()
  );
});

Given(
  'the agents run where T3 runs them, on a worker whose service manager cannot be read',
  (world) => {
    machine(world).service = true;
    machine(world).commands.answer(isManagerEnvironment, failed());
  }
);

Then(
  'every launcher ran with exactly this environment:',
  (world, table: DataTable) => {
    const launched = machine(world).commands.calls.filter((call) =>
      isLaunch(call.command)
    );
    expect(launched.length).toBeGreaterThan(0);
    for (const call of launched) {
      expect(call.options?.isolatedEnv).toBe(true);
      expect(call.options?.env).toEqual(table.rowsHash());
    }
  }
);

Then(
  'every launcher was run directly, as T3 runs it, never through {string}',
  (world, runner: string) => {
    const launched = machine(world).commands.ran(isLaunch);
    expect(launched.length).toBeGreaterThan(0);
    for (const command of launched) expect(command[0]).not.toBe(runner);
  }
);

Then('no launcher was run', (world) => {
  expect(machine(world).commands.ran(isLaunch)).toEqual([]);
});

Then(
  /^the check "([^"]+)" (fails|warns)$/,
  (world, id: string, verdict: string) => {
    expect(check(world, id).status).toBe(verdict === 'fails' ? 'fail' : 'warn');
  }
);

Then('every session check reports {string}', (world, summary: string) => {
  const sessions = machine(world).checks.filter((entry) =>
    entry.id.endsWith(':session')
  );
  expect(sessions).toHaveLength(NATIVE_AGENTS.length);
  for (const entry of sessions) expect(entry.summary).toBe(summary);
});

const check = (world: AgentsWorld, id: string): Check => {
  const found = machine(world).checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`There is no check ${id}.`);
  return found;
};
const launchers = (world: AgentsWorld): string[] =>
  machine(world)
    .commands.ran(isLaunch)
    .map((command) => String(launcherOf(command)))
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
  // One launcher for every agent: T3's binaryPath on a worker's service.
  expect(launchers(world)).toEqual(
    NATIVE_AGENTS.map((agent) =>
      machine(world).service ? agent.launcher : agent.wrapper
    ).sort()
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
