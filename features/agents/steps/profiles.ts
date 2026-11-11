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
import { join } from 'node:path';
import { fieldNames } from '../../../src/agents/audit';
import {
  convergeAgents,
  plan,
  publicPlan,
  type Context,
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
}));

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
  await convergeAgents(context(world));
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
    await world.attempt(() =>
      convergeAgents(context(world), Boolean(adopting))
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
