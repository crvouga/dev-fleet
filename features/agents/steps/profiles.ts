import { expect } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fieldNames } from '../../../src/agents/audit';
import {
  convergeAgents,
  plan,
  profileVariables,
  publicPlan,
  receiptFor,
  type Context,
  type ProfilePlay,
  type ProfileVariables,
} from '../../../src/agents/converge';
import { safeParents } from '../../../src/agents/files';
import {
  digest,
  resolveModel,
  select,
  type Profile,
  type Tool,
} from '../../../src/agents/registry';
import { agentRoot, render } from '../../../src/agents/render';
import type { PlatformName } from '../../../src/platform/types';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type AgentsWorld } from './world';
import { changedCount, lockedPlay, type PlayRun } from '../support/ansible';

export const profiles = steps<AgentsWorld>();
const { Given, When, Then } = profiles;

type Preview = Awaited<ReturnType<typeof plan>>;
type Reviewed = Parameters<typeof resolveModel>[3];

const profile = part(() => ({
  settings: undefined as unknown,
  names: [] as string[],
  rendered: {} as Record<string, string>,
  directory: undefined as string | undefined,
  model: undefined as string | null | undefined,
  reviewed: undefined as Reviewed,
  context: undefined as Context | undefined,
  preview: undefined as Preview | undefined,
  receipt: undefined as string | undefined,
  /** Every run of the agents play, in order. */
  runs: [] as PlayRun[],
  play: undefined as ProfilePlay | undefined,
}));

/** The real agents play, run by the locked Ansible. */
const play = async (world: AgentsWorld): Promise<ProfilePlay> =>
  (profile(world).play ??= await lockedPlay(world, profile(world).runs));

// ── Audit ────────────────────────────────────────────────────────────────

Given('an agent has these settings:', (world, settings: string) => {
  profile(world).settings = JSON.parse(settings);
});

When('the settings are audited', (world) => {
  profile(world).names = fieldNames(profile(world).settings);
});

Then('the audit names exactly:', (world, table: DataTable) => {
  expect(profile(world).names).toEqual(table.list());
});

Then('the audit does not contain {string}', (world, text: string) => {
  expect(JSON.stringify(profile(world).names)).not.toContain(text);
});

// ── Rendering ────────────────────────────────────────────────────────────

When(
  'the {string} profile of {string} is rendered for the machine {string}',
  (world, name: string, tool: string, machine: string) => {
    profile(world).rendered = render(select(machine, tool, name));
  }
);

Then('its {string} contains:', (world, file: string, table: DataTable) => {
  const content = profile(world).rendered[file];
  expect(content).toBeString();
  for (const text of table.list()) expect(content).toContain(text);
});

Then(
  'its {string} does not contain {string}',
  (world, file: string, text: string) => {
    const content = profile(world).rendered[file];
    expect(content).toBeString();
    expect(content).not.toContain(text);
  }
);

When(
  'agent profiles are located for the home {string} on {string}',
  (world, home: string, platform: PlatformName) => {
    profile(world).directory = agentRoot(home, platform);
  }
);

Then('they are kept under {string}', (world, directory: string) => {
  expect(profile(world).directory).toBe(directory);
});

// ── Models ───────────────────────────────────────────────────────────────

When(
  '{string} is selected with the {string} profile on the machine {string}',
  async (world, tool: string, name: string, machine: string) => {
    await world.attempt(() => {
      profile(world).model = select(machine, tool, name).model;
    });
  }
);

Given(
  'the registry approves the model {string} for {string} with the {string} profile on the machine {string}',
  (world, model: string, tool: string, name: string, machine: string) => {
    profile(world).reviewed = { [machine]: { [tool]: { [name]: model } } };
  }
);

When(
  'the model of {string} with the {string} profile on the machine {string} is resolved',
  (world, tool: Tool, name: Profile, machine: string) => {
    profile(world).model = resolveModel(
      machine,
      tool,
      name,
      profile(world).reviewed
    );
  }
);

Then('its model is {string}', (world, model: string) => {
  expect(profile(world).model).toBe(model);
});

// ── Applying ─────────────────────────────────────────────────────────────

const context = (world: AgentsWorld): Context => profile(world).context!;
const planned = async (world: AgentsWorld, file: string) => {
  const found = (await plan(context(world))).files.find(
    (entry) => entry.name === file
  );
  if (!found) throw new Error(`The profile has no file ${file}.`);
  return found;
};

Given(
  'the {string} profile of {string} for the machine {string} at the revision {string}, in an empty agent directory',
  async (
    world,
    name: string,
    tool: string,
    machine: string,
    revision: string
  ) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ws-agents-')));
    world.defer(() => rm(root, { recursive: true, force: true }));
    profile(world).context = {
      root,
      revision,
      selection: select(machine, tool, name),
    };
  }
);

Given('the profile has been applied', async (world) => {
  await convergeAgents(context(world), false, await play(world));
  profile(world).receipt = await readFile(
    (await plan(context(world))).receiptPath,
    'utf8'
  );
});

Given(
  '{string} has since been overwritten with {string}',
  async (world, file: string, text: string) => {
    await writeFile((await planned(world, file)).path, text);
  }
);

Given(
  'another apply holds {string} in the agent directory',
  async (world, lock: string) => {
    await mkdir(join(context(world).root, lock));
  }
);

Given(
  '{string} in the agent directory is a symlink to the agent directory',
  async (world, name: string) => {
    await symlink(context(world).root, join(context(world).root, name));
  }
);

When('the profile is previewed', async (world) => {
  profile(world).preview = await plan(context(world));
});

When(
  /^the profile is applied(?: again)?(, adopting what is there)?$/,
  async (world, adopting?: string) => {
    const apply = await play(world);
    profile(world).runs.length = 0;
    await world.attempt(() =>
      convergeAgents(context(world), Boolean(adopting), apply)
    );
  }
);

When('the destination {string} is checked', async (world, path: string) => {
  await world.attempt(() => safeParents(join(context(world).root, path)));
});

Then(
  'the preview reports {string} as {string}',
  (world, file: string, state: string) => {
    expect(
      profile(world).preview!.files.find((entry) => entry.name === file)?.state
    ).toBe(state as 'create');
  }
);

Then('the agent directory is still empty', async (world) => {
  expect(await readdir(context(world).root)).toEqual([]);
});

Then(
  'a preview reports {string} as {string}',
  async (world, file: string, state: string) => {
    expect((await planned(world, file)).state).toBe(state as 'unchanged');
  }
);

Then('its receipt is as the first apply wrote it', async (world) => {
  expect(world.refusal).toBeUndefined();
  expect(await readFile((await plan(context(world))).receiptPath, 'utf8')).toBe(
    profile(world).receipt!
  );
});

Then(
  'its receipt records the SHA-256 digest of {string} as rendered',
  async (world, file: string) => {
    const receipt = JSON.parse(profile(world).receipt!) as {
      files: Record<string, string>;
    };
    expect(receipt.files[file]).toBe(
      digest((await planned(world, file)).content)
    );
  }
);

Then(
  'the public plan does not contain {string}',
  async (world, text: string) => {
    expect(
      JSON.stringify(
        publicPlan(await plan(context(world)), context(world).revision)
      )
    ).not.toContain(text);
  }
);

// ── The agents play ──────────────────────────────────────────────────────

/** The variables an apply of the profile as it is now gives the play. */
async function variables(world: AgentsWorld): Promise<ProfileVariables> {
  const result = await plan(context(world));
  const { receipt } = receiptFor(result, context(world).revision);
  return profileVariables(context(world), receipt);
}

/** Every regular file under a directory, by its path relative to it. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
}

Then('the agents play was not run', (world) => {
  expect(profile(world).runs).toEqual([]);
});

Then('the agents play was run {int} time(s)', (world, count: number) => {
  expect(profile(world).runs).toHaveLength(count);
});

Then(
  'the profile holds exactly the files dev-fleet specifies, and its receipt',
  async (world) => {
    const { directory, files } = await plan(context(world));
    expect(await filesUnder(directory)).toEqual(
      [...files.map((file) => file.name), 'receipt.json'].sort()
    );
  }
);

Then(
  'every file of the profile holds, byte for byte, what dev-fleet specifies for it',
  async (world) => {
    const { directory } = await plan(context(world));
    const specified = render(context(world).selection);
    expect(Object.keys(specified).length).toBeGreaterThan(0);
    for (const [name, content] of Object.entries(specified))
      expect(
        Buffer.compare(
          await readFile(join(directory, name)),
          Buffer.from(content, 'utf8')
        )
      ).toBe(0);
  }
);

Then(
  'its receipt records the SHA-256 digest of every file as written',
  async (world) => {
    const { directory, receiptPath } = await plan(context(world));
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      files: Record<string, string>;
    };
    for (const name of Object.keys(render(context(world).selection)))
      expect(receipt.files[name]).toBe(
        digest(await readFile(join(directory, name), 'utf8'))
      );
  }
);

Then(
  'its receipt is, byte for byte, the one dev-fleet records for it',
  async (world) => {
    const result = await plan(context(world));
    expect(await readFile(result.receiptPath, 'utf8')).toBe(
      receiptFor(result, context(world).revision).encoded
    );
  }
);

Then(
  'its {string} is, byte for byte:',
  async (world, file: string, expected: string) => {
    const { directory } = await plan(context(world));
    expect(await readFile(join(directory, file), 'utf8')).toBe(expected + '\n');
  }
);

Then(
  'the only backup in the agent directory holds {string}',
  async (world, text: string) => {
    const backups = join(context(world).root, 'backups');
    const kept = await Promise.all(
      (await readdir(backups)).map((name) =>
        readFile(join(backups, name), 'utf8')
      )
    );
    expect(kept).toEqual([text]);
  }
);

When('the agents play runs again with the same variables', async (world) => {
  const apply = await play(world);
  profile(world).runs.length = 0;
  await apply(await variables(world));
});

When('the agents play is run in check mode for the profile', async (world) => {
  const check = await lockedPlay(world, profile(world).runs, { check: true });
  await check(await variables(world));
});

When(
  'the agents play is told {string} must have the digest {string}',
  async (world, file: string, wrong: string) => {
    const given = await variables(world);
    await (
      await play(world)
    )({ ...given, agent_files: { ...given.agent_files, [file]: wrong } });
  }
);

Then('the play succeeded', (world) => {
  expect(profile(world).runs.map((run) => run.result.ok)).toEqual([true]);
});

Then('the play failed with {string}', (world, code: string) => {
  const [run, ...others] = profile(world).runs;
  expect(others).toEqual([]);
  expect(run?.result.ok).toBe(false);
  expect(run?.result.stdout).toContain(code);
});

Then('the play reported no change', (world) => {
  expect(profile(world).runs.map((run) => changedCount(run.result))).toEqual([
    0,
  ]);
});

Then('the profile holds no file', async (world) => {
  expect(await filesUnder((await plan(context(world))).directory)).toEqual([]);
});
