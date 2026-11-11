import { expect } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  dockerChecks,
  toolChecks,
  worktreeTrustCheck,
  type Check,
  type Runner,
} from '../../../bootstrap/doctor';
import {
  AGENT_WORKTREE_ROOTS,
  assertManagedConfig,
  publishGlobalConfig,
  withTrustedPaths,
} from '../../../bootstrap/global-config';
import { awsWindowsArtifact } from '../../../bootstrap/native-aws';
import { steps, type DataTable } from '../../support/gherkin';
import { lines, part, type BootstrapWorld } from './world';

export const toolchain = steps<BootstrapWorld>();
const { Given, When, Then } = toolchain;

const checkout = resolve(import.meta.dir, '../../..');
const tracked = (path: string): string =>
  readFileSync(join(checkout, path), 'utf8');
const quoted = (text: string): string[] =>
  [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);

// ── The global mise configuration ────────────────────────────────────────

const published = part((world) => {
  const root = world.directory('toolchain-');
  return {
    source: join(root, 'source'),
    target: join(root, 'global'),
    touched: [] as { path: string; seconds: number }[],
    project: '',
    result: undefined as string | undefined,
  };
});
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const publishedFile = (world: BootstrapWorld, name: string): string =>
  join(published(world).target, name);
const settings = (world: BootstrapWorld): Record<string, unknown> =>
  (
    Bun.TOML.parse(
      readFileSync(publishedFile(world, 'config.toml'), 'utf8')
    ) as {
      settings: Record<string, unknown>;
    }
  ).settings;

Given(
  'a toolchain whose {string} reads:',
  (world, name: string, text: string) => {
    write(join(published(world).source, name), lines(text));
  }
);

Given(
  "the toolchain's {string} holds {string}",
  (world, name: string, text: string) => {
    write(join(published(world).source, name), text);
  }
);

Given(/^the global configuration has been published(?: again)?$/, (world) => {
  publishGlobalConfig(published(world).target, published(world).source);
});

Given(
  'these published files were last written at the second {int}:',
  (world, seconds: number, table: DataTable) => {
    for (const name of table.list()) {
      const path = publishedFile(world, name);
      utimesSync(path, seconds, seconds);
      published(world).touched.push({ path, seconds });
    }
  }
);

Given(
  'the published {string} has since been replaced with:',
  (world, name: string, text: string) => {
    writeFileSync(publishedFile(world, name), lines(text));
  }
);

Given(
  '{string} has been added to the trusted paths of the published configuration',
  (world, path: string) => {
    const config = publishedFile(world, 'config.toml');
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace(
        /trusted_config_paths = \[/,
        `trusted_config_paths = [${JSON.stringify(path)}, `
      )
    );
  }
);

Given('a global configuration that reads:', (world, text: string) => {
  write(publishedFile(world, 'config.toml'), lines(text));
});

When(/^the global configuration is published(?: again)?$/, async (world) => {
  await world.attempt(() =>
    publishGlobalConfig(published(world).target, published(world).source)
  );
});

When('the global configuration is checked for its owner', async (world) => {
  await world.attempt(() => assertManagedConfig(published(world).target));
});

Then('none of them was written again', (world) => {
  const { touched } = published(world);
  expect(touched.length).toBeGreaterThan(0);
  for (const { path, seconds } of touched)
    expect(statSync(path).mtimeMs).toBe(seconds * 1000);
});

Then(
  'the published {string} holds {string}',
  (world, name: string, text: string) => {
    expect(readFileSync(publishedFile(world, name), 'utf8')).toBe(text);
  }
);

Then('the published {string} reads:', (world, name: string, text: string) => {
  expect(readFileSync(publishedFile(world, name), 'utf8')).toBe(lines(text));
});

Then(
  'the published configuration trusts exactly the agent worktree roots:',
  (world, table: DataTable) => {
    expect(settings(world)['trusted_config_paths']).toEqual(table.list());
    expect(table.list()).toEqual(AGENT_WORKTREE_ROOTS);
  }
);

Then(
  'the published configuration trusts exactly, in order:',
  (world, table: DataTable) => {
    expect(settings(world)['trusted_config_paths']).toEqual(table.list());
  }
);

Then('the published setting {string} is true', (world, name: string) => {
  expect(settings(world)[name]).toBe(true);
});

Given('a project configuration that reads:', (world, text: string) => {
  published(world).project = lines(text);
});

When(
  'the trusted path {string} is added to it',
  async (world, path: string) => {
    const state = published(world);
    await world.attempt(() => {
      state.result = withTrustedPaths(state.project, [path]);
    });
  }
);

Then('the project configuration reads:', (world, text: string) => {
  expect(published(world).result).toBe(lines(text));
});

Then(
  'the mise.toml of this repository has no setting {string}',
  (_world, name: string) => {
    const config = Bun.TOML.parse(tracked('mise.toml')) as {
      settings?: Record<string, unknown>;
    };
    expect(config.settings?.[name]).toBeUndefined();
  }
);

// ── The lock ─────────────────────────────────────────────────────────────

type Pin = string | { version: string; lazy?: boolean; os?: string[] };
interface Config {
  settings: { lockfile_platforms: string[] };
  tools: Record<string, Pin>;
}
interface Locked {
  name: string;
  version: string;
  /** The operating systems the tool is restricted to, if any. */
  os: string[] | undefined;
  row: Record<string, unknown> | undefined;
}
const lock = part(() => ({
  config: undefined as Config | undefined,
  base: [] as Locked[],
}));
const graphs = (world: BootstrapWorld): { path: string; digest: string }[] =>
  lock(world).base.flatMap(({ row }) =>
    row?.['aube'] ? [row['aube'] as { path: string; digest: string }] : []
  );

When('every tool mise.toml pins is looked up in mise.lock', (world) => {
  const config = Bun.TOML.parse(tracked('mise.toml')) as unknown as Config;
  const locked = Bun.TOML.parse(tracked('mise.lock')) as {
    tools: Record<string, Record<string, unknown>[]>;
  };
  lock(world).config = config;
  lock(world).base = Object.entries(config.tools)
    .filter(([, pin]) => typeof pin === 'string' || !pin.lazy)
    .map(([name, pin]) => {
      const version = typeof pin === 'string' ? pin : pin.version;
      return {
        name,
        version,
        os: typeof pin === 'string' ? undefined : pin.os,
        row: locked.tools[name]?.find((entry) => entry['version'] === version),
      };
    });
});

Then(
  'every tool that is not lazy is locked at the version it is pinned to',
  (world) => {
    expect(lock(world).base.length).toBeGreaterThan(0);
    for (const { name, row } of lock(world).base)
      expect(row, name).toBeDefined();
  }
);

Then(
  'every tool installed from a dependency graph is locked by a {string} digest',
  (world, prefix: string) => {
    expect(graphs(world).length).toBeGreaterThan(0);
    for (const graph of graphs(world)) expect(graph.digest).toStartWith(prefix);
  }
);

Then('the lock of every such graph records {string}', (world, text: string) => {
  for (const graph of graphs(world))
    expect(tracked(join(graph.path, 'aube-lock.yaml'))).toContain(text);
});

Then(
  '{string} is locked by the backend {string}, at a release number',
  (world, name: string, backend: string) => {
    const row = lock(world).base.find((tool) => tool.name === name)?.row;
    expect(row?.['backend']).toBe(backend);
    expect(row?.['version']).toMatch(/^\d+\.\d+\.\d+$/);
  }
);

Then(
  'on Windows {string} comes from its native installer, at the pinned version and with a SHA-256 digest',
  (world, name: string) => {
    const artifact = awsWindowsArtifact(
      lock(world).config as unknown as Parameters<typeof awsWindowsArtifact>[0]
    );
    const pin = lock(world).base.find((tool) => tool.name === name);
    expect(artifact.version).toBe(pin!.version);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
);

Then(
  'every other tool carries a {string} checksum for each platform it is installed on',
  (world, prefix: string) => {
    const { config, base } = lock(world);
    let checked = 0;
    for (const { name, os, row } of base) {
      if (row?.['aube'] || name === 'rust') continue;
      for (const platform of config!.settings.lockfile_platforms) {
        // A tool restricted to some operating systems is never installed elsewhere.
        if (os && !os.includes(platform.split('-')[0]!)) continue;
        // On Windows aws is not installed by mise: see its own step.
        if (name === 'aws' && platform === 'windows-x64') continue;
        const artifact = row?.[`platforms.${platform}`] as
          { checksum?: string } | undefined;
        expect(artifact?.checksum, `${name} ${platform}`).toStartWith(prefix);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }
);

// ── The doctor ───────────────────────────────────────────────────────────

const doctor = part(() => ({
  tools: {} as Parameters<typeof toolChecks>[0],
  prints: new Map<string, string>(),
  otherwise: undefined as string | undefined,
  trusted: { ok: false, output: '' } as ReturnType<Runner>,
  checks: [] as Check[],
}));
/** Answers for every command the doctor would run; none is started. */
const runner =
  (world: BootstrapWorld): Runner =>
  (command) => {
    const { prints, otherwise } = doctor(world);
    const output = prints.get(command[0]!) ?? otherwise;
    return output === undefined
      ? { ok: false, output: '' }
      : { ok: true, output };
  };
const STATUS = { passes: 'pass', warns: 'warn', fails: 'fail' } as const;

Given('the toolchain pins:', (world, table: DataTable) => {
  for (const row of table.hashes()) {
    const { tool = '', version = '', lazy, os } = row;
    doctor(world).tools[tool] =
      lazy || os
        ? {
            version,
            ...(lazy ? { lazy: true } : {}),
            ...(os ? { os: os.split(', ') } : {}),
          }
        : version;
  }
});

Given(
  'the command {string} prints {string}',
  (world, command: string, output: string) => {
    doctor(world).prints.set(command, output);
  }
);

Given('every other command prints {string}', (world, output: string) => {
  doctor(world).otherwise = output;
});

Given('no command can be run', (world) => {
  doctor(world).prints.clear();
  doctor(world).otherwise = undefined;
});

Given(
  /^mise says it trusts the configuration paths (.+)$/,
  (world, paths: string) => {
    doctor(world).trusted = { ok: true, output: paths };
  }
);

Given('mise cannot say which configuration paths it trusts', (world) => {
  doctor(world).trusted = { ok: false, output: '' };
});

When(
  /^the doctor checks the tools(?: on "([^"]*)")?$/,
  (world, platform?: string) => {
    const { tools } = doctor(world);
    doctor(world).checks = platform
      ? toolChecks(tools, runner(world), platform)
      : toolChecks(tools, runner(world));
  }
);

When(
  /^the doctor checks Docker on a machine that (requires|does not require) it$/,
  (world, requirement: string) => {
    doctor(world).checks = dockerChecks(
      requirement === 'requires',
      runner(world)
    );
  }
);

When(
  'the doctor checks that agent worktrees are trusted, for the home {string}',
  (world, home: string) => {
    doctor(world).checks = [
      worktreeTrustCheck(() => doctor(world).trusted, home),
    ];
  }
);

Then(
  /^the check "([^"]*)" (passes|fails)$/,
  (world, id: string, verdict: keyof typeof STATUS) => {
    expect(doctor(world).checks.find((check) => check.id === id)?.status).toBe(
      STATUS[verdict]
    );
  }
);

Then('there is no check {string}', (world, id: string) => {
  expect(doctor(world).checks.find((check) => check.id === id)).toBeUndefined();
});

Then(/^of the pinned tools it checks (.+)$/, (world, expected: string) => {
  const { checks, tools } = doctor(world);
  expect(checks.map((check) => check.id).filter((id) => id in tools)).toEqual(
    quoted(expected)
  );
});

Then(
  /^every Docker check (warns|fails)$/,
  (world, verdict: keyof typeof STATUS) => {
    const { checks } = doctor(world);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.status === STATUS[verdict])).toBe(
      true
    );
  }
);
