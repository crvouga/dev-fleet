import { expect } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  setupFailureCode,
  setupStatus,
  type SetupPhase,
} from '../../../bootstrap/setup-status';
import {
  appendOnce,
  configurePosixShellPath,
  miseDataDir,
} from '../../../bootstrap/shell-path';
import { steps } from '../../support/gherkin';
import { lines, part, type BootstrapWorld } from './world';

export const installer = steps<BootstrapWorld>();
const { Given, When, Then } = installer;

// ── Installer evidence ───────────────────────────────────────────────────

type Reported = 'running' | 'failed' | 'passed';
const evidence = part((world) => {
  const root = world.directory('setup-status-');
  const path = join(root, 'status.json');
  return {
    root,
    path,
    report: setupStatus(path),
    code: undefined as string | undefined,
  };
});

Given(
  'the installer has reported the phase {string} as {string}',
  (world, phase: SetupPhase, status: Reported) => {
    evidence(world).report(phase, status);
  }
);

Given(
  'a file {string} beside the status file that holds {string}',
  (world, name: string, text: string) => {
    writeFileSync(join(evidence(world).root, name), text);
  }
);

Given('the status file is a symlink to {string}', (world, name: string) => {
  symlinkSync(join(evidence(world).root, name), evidence(world).path);
});

When(
  'the installer reports the phase {string} as {string}',
  async (world, phase: SetupPhase, status: Reported) => {
    await world.attempt(() => evidence(world).report(phase, status));
  }
);

Then('the status file holds:', (world, json: string) => {
  expect(JSON.parse(readFileSync(evidence(world).path, 'utf8'))).toEqual(
    JSON.parse(json)
  );
});

Then('only its owner can read or write the status file', (world) => {
  expect(statSync(evidence(world).path).mode & 0o777).toBe(0o600);
});

Then(
  '{string} beside the status file still holds {string}',
  (world, name: string, text: string) => {
    expect(readFileSync(join(evidence(world).root, name), 'utf8')).toBe(text);
  }
);

When(
  'the installer fails with the error {string}',
  (world, message: string) => {
    evidence(world).code = setupFailureCode(new Error(message));
  }
);

Then('no failure code is recorded', (world) => {
  expect(evidence(world).code).toBeUndefined();
});

Then('the failure code {string} is recorded', (world, code: string) => {
  expect(evidence(world).code).toBe(code);
});

// ── The PATH of every shell ──────────────────────────────────────────────

const shell = part((world) => ({
  home: world.directory('shell-path-'),
  tools: '',
  shims: '',
  zdotdir: undefined as string | undefined,
  /** What each file held after the last `Given` that wrote it. */
  before: new Map<string, string>(),
  block: '',
  ran: undefined as SpawnSyncReturns<string> | undefined,
}));

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
/** `{home}`, `{shims}` and `{tools}` stand for the scenario's directories;
 * `{pinned directories}` for the shims and tools as one quoted PATH entry.
 */
const expand = (world: BootstrapWorld, text: string): string => {
  const { home, shims, tools } = shell(world);
  return text
    .replaceAll('{pinned directories}', quote(`${shims}:${tools}`))
    .replaceAll('{home}', home)
    .replaceAll('{shims}', shims)
    .replaceAll('{tools}', tools);
};
const inHome = (world: BootstrapWorld, name: string): string =>
  join(shell(world).home, name);
const read = (world: BootstrapWorld, name: string): string =>
  readFileSync(inHome(world, name), 'utf8');
const remember = (world: BootstrapWorld): void => {
  const { home, before } = shell(world);
  for (const entry of readdirSync(home, { withFileTypes: true }))
    if (entry.isFile()) before.set(entry.name, read(world, entry.name));
};
const tool = (path: string, prints: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf ${prints}`, { mode: 0o755 });
};
const configure = (world: BootstrapWorld): void => {
  const { home, tools, shims, zdotdir } = shell(world);
  configurePosixShellPath(tools, shims, home, zdotdir ?? home);
};

Given(
  'a home directory with the tool directory {string} and the shims directory {string}',
  (world, tools: string, shims: string) => {
    const state = shell(world);
    state.tools = join(state.home, tools);
    state.shims = join(state.home, shims);
    mkdirSync(state.tools);
    mkdirSync(state.shims);
  }
);

Given(
  '{string} in the shims directory prints {string}',
  (world, name: string, prints: string) => {
    tool(join(shell(world).shims, name), prints);
  }
);

Given(
  '{string} in the directory {string} of the home directory prints {string}',
  (world, name: string, directory: string, prints: string) => {
    tool(join(inHome(world, directory), name), prints);
  }
);

Given(
  '{string} in the home directory reads:',
  (world, name: string, text: string) => {
    writeFileSync(inHome(world, name), expand(world, lines(text)));
  }
);

Given(
  'zsh keeps its startup files in {string} in the home directory',
  (world, name: string) => {
    shell(world).zdotdir = inHome(world, name);
  }
);

Given('the shell PATH has been set up', (world) => {
  configure(world);
  remember(world);
});

When(/^the shell PATH is set up(?: again)?$/, (world) => {
  configure(world);
});

Given(
  'this block has been appended to {string} in the home directory:',
  (world, name: string, block: string) => {
    shell(world).block = block;
    appendOnce(inHome(world, name), block);
    remember(world);
  }
);

When(
  'the same block is appended to {string} in the home directory again',
  (world, name: string) => {
    appendOnce(inHome(world, name), shell(world).block);
  }
);

Then('{string} in the home directory is unchanged', (world, name: string) => {
  const before = shell(world).before.get(name);
  expect(before).toBeString();
  expect(read(world, name)).toBe(before!);
});

Then(
  '{string} in the home directory contains:',
  (world, name: string, text: string) => {
    expect(read(world, name)).toContain(lines(text));
  }
);

Then(
  '{string} in the home directory contains {string}',
  (world, name: string, text: string) => {
    expect(read(world, name)).toContain(text);
  }
);

Then(
  '{string} in the home directory contains {string} {int} time(s)',
  (world, name: string, text: string, count: number) => {
    expect(read(world, name).split(text).length - 1).toBe(count);
  }
);

Then(
  '{string} in the home directory still starts with the line {string}',
  (world, name: string, line: string) => {
    expect(read(world, name)).toStartWith(lines(line));
  }
);

Then('the home directory holds no {string}', (world, name: string) => {
  expect(readdirSync(shell(world).home)).not.toContain(name);
});

Then(
  'a noninteractive Bash with the PATH {string} that reads {string} on startup can run {string}',
  (world, path: string, startup: string, command: string) => {
    const state = shell(world);
    state.ran = spawnSync('/bin/bash', ['-c', command], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { HOME: state.home, PATH: path, BASH_ENV: inHome(world, startup) },
    });
    expect(state.ran.status).toBe(0);
  }
);

Then(
  'a noninteractive zsh with the PATH {string} can run:',
  (world, path: string, command: string) => {
    const state = shell(world);
    state.ran = spawnSync('/bin/zsh', ['-c', command], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { HOME: state.home, ZDOTDIR: state.zdotdir!, PATH: path },
    });
    expect(state.ran.status).toBe(0);
  }
);

Then('it prints {string}', (world, text: string) => {
  expect(shell(world).ran!.stdout).toBe(text);
});

Then('it prints the line {string}', (world, line: string) => {
  expect(shell(world).ran!.stdout).toBe(lines(expand(world, line)));
});

Then('it prints nothing to standard error', (world) => {
  expect(shell(world).ran!.stderr).toBe('');
});

// ── Where mise keeps its data ────────────────────────────────────────────

const located = part(() => ({ data: undefined as string | undefined }));

When(
  /^the mise data directory is located on "([^"]*)" for the home "([^"]*)", with (.+)$/,
  (world, platform: NodeJS.Platform, home: string, setting: string) => {
    const [name, value] = setting.split('=');
    located(world).data = miseDataDir(
      platform,
      value === undefined ? {} : { [name!]: value },
      home
    );
  }
);

Then('mise keeps its data in {string}', (world, directory: string) => {
  expect(located(world).data).toBe(directory);
});
