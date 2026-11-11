import { expect } from 'bun:test';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { desired } from '../../../src/t3/desired';
import { read } from '../../../src/t3/files';
import {
  conformNames,
  conformT3Names,
  localAccounts,
  type Accounts,
} from '../../../src/t3/names';
import { providerNames } from '../../../src/t3/names-check';
import { importT3, reconcileT3 } from '../../../src/t3/reconcile';
import type { Check } from '../../../src/types';
import type { DataTable } from '../../support/gherkin';
import {
  at,
  attempt,
  cli,
  expand,
  json,
  listed,
  part,
  pattern,
  proxy,
  put,
  temporary,
  type CliWorld,
} from './world';

const { Given, When, Then } = cli;

const ROOT = resolve(import.meta.dir, '../../..');
const SHIPPED = join(ROOT, 'agents/t3.json');

type Instances = Record<string, unknown>;

const t3 = part(() => ({
  /** The T3 base directory of this scenario, and the two files in it. */
  home: '',
  settings: '',
  ownership: '',
  /** T3's settings as the scenario first wrote them. */
  given: undefined as unknown,
  /** What every provider the fleet declares in this scenario is. */
  instance: undefined as unknown,
  /** What the last preview, apply, adoption or renaming reported. */
  report: undefined as unknown,
  reviewed: undefined as string | undefined,
  /** When T3's settings were last written, before the `When` step. */
  modified: undefined as number | undefined,
  linked: '',
  definition: '',
  declared: undefined as Instances | undefined,
  accounts: undefined as Accounts | undefined,
  listed: {} as Instances,
  managed: {} as Record<string, string>,
  named: undefined as Instances | undefined,
  check: undefined as Check | undefined,
  logins: '',
  account: undefined as string | undefined,
  contents: undefined as string | null | undefined,
}));

/** Makes a directory the T3 home of the scenario. */
export function useHome(world: CliWorld, home: string): void {
  const state = t3(world);
  state.home = home;
  state.settings = join(home, 'userdata/settings.json');
  state.ownership = join(home, 'userdata/personal-managed.json');
  world.names['T3_HOME'] = home;
}

function home(world: CliWorld) {
  const state = t3(world);
  if (!state.home) throw new Error('The scenario has no T3 home.');
  return state;
}

async function store(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const settings = async (world: CliWorld): Promise<unknown> =>
  JSON.parse(await readFile(home(world).settings, 'utf8'));

// ── A T3 home ────────────────────────────────────────────────────────────

Given('a T3 home', async (world) => {
  useHome(world, await temporary(world, 'personal-t3-'));
});

Given("T3's settings hold:", async (world, document: string) => {
  const state = home(world);
  state.given = json(document);
  await store(state.settings, JSON.stringify(state.given));
});

Given(
  /^T3's settings were edited to set "([^"]+)" to (.+)$/,
  async (world, path: string, value: string) => {
    const edited = await settings(world);
    put(edited, path, json(value));
    await writeFile(home(world).settings, JSON.stringify(edited));
  }
);

Given(
  "T3's settings are a symbolic link to a file that reads {string}",
  async (world, text: string) => {
    const state = home(world);
    state.linked = join(state.home, 'target.json');
    await store(state.linked, text);
    await mkdir(dirname(state.settings), { recursive: true });
    await symlink(state.linked, state.settings);
  }
);

Given('the ownership record reads {string}', async (world, text: string) => {
  await store(home(world).ownership, text);
});

Given(
  'an apply was interrupted after recording that the fleet owns {string}',
  async (world, ids: string) => {
    const state = home(world);
    await store(
      state.ownership,
      JSON.stringify({
        version: 1,
        target: state.settings,
        instances: listed(ids),
      })
    );
  }
);

Given('another T3 operation holds the lock', async (world) => {
  await mkdir(`${home(world).ownership}.lock`, { recursive: true });
});

// ── Reconciling providers ────────────────────────────────────────────────

Given(
  'every provider the fleet declares here is:',
  (world, document: string) => {
    t3(world).instance = json(document);
  }
);

async function reconcile(
  world: CliWorld,
  ids: string | undefined,
  apply: boolean,
  reviewed: boolean
) {
  const state = home(world);
  const report = await reconcileT3(
    { settings: state.settings, state: state.ownership },
    Object.fromEntries(listed(ids ?? '').map((id) => [id, state.instance])),
    { apply, ...(reviewed ? { planHash: state.reviewed! } : {}) }
  );
  if (!apply) state.reviewed = report.planHash;
  return report;
}

Given(
  /^(?:the providers "([^"]*)"|no providers) have been (previewed|applied)( with the reviewed plan)?$/,
  async (world, ids: string | undefined, how: string, reviewed?: string) => {
    await reconcile(world, ids, how === 'applied', Boolean(reviewed));
  }
);

When(
  /^(?:the providers "([^"]*)"|no providers) are (previewed|applied)( with the reviewed plan)?$/,
  async (world, ids: string | undefined, how: string, reviewed?: string) => {
    const state = home(world);
    state.modified = (await stat(state.settings).catch(() => undefined))
      ?.mtimeMs;
    state.report = await attempt(world, () =>
      reconcile(world, ids, how === 'applied', Boolean(reviewed))
    );
  }
);

const adopt = (world: CliWorld, id: string) =>
  importT3(
    { settings: home(world).settings, state: home(world).ownership },
    id
  );

Given('the provider {string} has been adopted', async (world, id: string) => {
  await adopt(world, id);
});

When('the provider {string} is adopted', async (world, id: string) => {
  t3(world).report = await attempt(world, () => adopt(world, id));
});

function reported(world: CliWorld): Record<string, unknown> {
  const { report } = t3(world);
  if (report === undefined) throw new Error('Nothing was reported.');
  return report as Record<string, unknown>;
}

Then('the plan is:', (world, table: DataTable) => {
  expect(reported(world)['changes']).toEqual(table.hashes());
});

Then('the report does not contain {string}', (world, part: string) => {
  expect(JSON.stringify(reported(world))).not.toContain(part);
});

Then('the report says nothing changed', (world) => {
  expect(reported(world)['changed']).toBe(false);
});

Then('it reports exactly:', (world, document: string) => {
  expect(reported(world)).toEqual(json(document) as Record<string, unknown>);
});

Then('no ownership record is written', async (world) => {
  expect(await Bun.file(home(world).ownership).exists()).toBe(false);
});

Then(
  'the ownership record does not contain {string}',
  async (world, part: string) => {
    expect(await readFile(home(world).ownership, 'utf8')).not.toContain(part);
  }
);

// ── T3's settings afterwards ─────────────────────────────────────────────

Then("T3's settings keep {string} as it was", async (world, path: string) => {
  const kept = at(home(world).given, path);
  if (kept === undefined) throw new Error(`The scenario gave no ${path}.`);
  expect(at(await settings(world), path)).toEqual(kept);
});

Then(
  /^in T3's settings, "([^"]+)" is (.+)$/,
  async (world, path: string, value: string) => {
    expect(at(await settings(world), path)).toEqual(json(value));
  }
);

Then(
  "in T3's settings, {string} contains {string}",
  async (world, path: string, part: string) => {
    expect(at(await settings(world), path)).toContain(expand(world, part));
  }
);

Then(
  'T3 is left with exactly these providers:',
  async (world, document: string) => {
    expect(at(await settings(world), 'providerInstances')).toEqual(
      json(document)
    );
  }
);

Then("T3's settings file still reads {string}", async (world, text: string) => {
  expect(await readFile(home(world).settings, 'utf8')).toBe(text);
});

Then(
  "the file T3's settings link to still reads {string}",
  async (world, text: string) => {
    expect(await readFile(home(world).linked, 'utf8')).toBe(text);
  }
);

Then("T3's settings file is not rewritten", async (world) => {
  const state = home(world);
  if (state.modified === undefined)
    throw new Error("T3's settings did not exist before.");
  expect((await stat(state.settings)).mtimeMs).toBe(state.modified);
});

Then("only its owner can read or write T3's settings file", async (world) => {
  if (process.platform === 'win32') return;
  expect((await stat(home(world).settings)).mode & 0o777).toBe(0o600);
});

// ── The definition, and the accounts on the CLI proxy ────────────────────

Given('no account is signed in on the CLI proxy', (world) => {
  world.proxy = async () => [];
});

Given(
  'these accounts are signed in on the CLI proxy:',
  (world, table: DataTable) => {
    world.proxy = async () =>
      table.hashes().map((row) => ({
        tool: row['tool']!,
        email: row['email']!,
        prefix: row['prefix']!,
        models: listed(row['models']!),
      }));
  }
);

Given('the CLI proxy does not answer: {string}', (world, reason: string) => {
  world.proxy = async () => {
    throw new Error(reason);
  };
});

Given(
  /^the T3 definition the package ships(?:, edited to set "([^"]+)" to (.+))?$/,
  async (world, path?: string, value?: string) => {
    const state = t3(world);
    const source = await readFile(SHIPPED, 'utf8');
    const edited = json(source);
    if (path) put(edited, path, json(value!));
    state.definition = join(
      await temporary(world, 'personal-t3-definition-'),
      'definition.json'
    );
    await writeFile(state.definition, path ? JSON.stringify(edited) : source);
  }
);

Given(
  'the T3 definition {string} reads:',
  async (world, path: string, document: string) => {
    await store(expand(world, path), JSON.stringify(json(document)));
  }
);

When(
  'the providers are worked out for the machine {string} with dev-fleet at {string}',
  async (world, id: string, workspace: string) => {
    const state = t3(world);
    state.declared = await attempt(world, () =>
      desired(state.definition, workspace, id, proxy(world))
    );
  }
);

function declared(world: CliWorld): Instances {
  const found = t3(world).declared;
  if (!found) throw new Error('No provider was worked out.');
  return found;
}

Then('exactly these providers are declared:', (world, table: DataTable) => {
  expect(Object.keys(declared(world)).sort()).toEqual(table.list());
});

Then('what is declared contains {string}', (world, part: string) => {
  expect(JSON.stringify(declared(world))).toContain(part);
});

Then(
  'the provider {string} is declared exactly as:',
  (world, id: string, document: string) => {
    expect(declared(world)[id]).toEqual(pattern(json(document)));
  }
);

Then(
  'the provider {string} is declared with at least:',
  (world, id: string, document: string) => {
    expect(declared(world)[id]).toMatchObject(
      json(document) as Record<string, unknown>
    );
  }
);

Then(
  'the T3 definition the package ships does not contain {string}',
  async (_world, part: string) => {
    expect(await readFile(SHIPPED, 'utf8')).not.toContain(part);
  }
);

When(
  'T3 configuration is read from the relative path {string}',
  async (world, path: string) => {
    t3(world).contents = await attempt(world, () => read(path));
  }
);

Then('it is found', (world) => {
  expect(t3(world).contents).not.toBeNull();
});

// ── Provider names ───────────────────────────────────────────────────────

Given(
  'these accounts are signed in on this machine, by where each login is kept:',
  (world, table: DataTable) => {
    const rows = table.hashes();
    // "default" is the provider's own home, "other" any home an instance
    // names, "any" either.
    t3(world).accounts = async (driver, homePath) =>
      rows.find(
        (row) =>
          row['driver'] === driver &&
          ['any', homePath ? 'other' : 'default'].includes(row['home']!)
      )?.['account'];
  }
);

Given('T3 lists these providers:', (world, document: string) => {
  t3(world).listed = json(document) as Instances;
});

Given('T3 lists no provider', (world) => {
  t3(world).listed = {};
});

Given(
  'the fleet manages these providers under these names:',
  (world, table: DataTable) => {
    t3(world).managed = Object.fromEntries(
      table.hashes().map((row) => [row['id']!, row['name']!])
    );
  }
);

When('the providers are named by the convention', async (world) => {
  const state = t3(world);
  state.named = await attempt(world, () =>
    conformNames(state.listed, state.managed, state.accounts)
  );
});

Then('T3 lists exactly these providers:', (world, document: string) => {
  expect(t3(world).named).toEqual(json(document) as Instances);
});

Then('T3 lists what it listed before', (world) => {
  expect(t3(world).named).toEqual(t3(world).listed);
});

Then('T3 lists the providers {string}, in that order', (world, ids: string) => {
  expect(Object.keys(t3(world).named ?? {})).toEqual(listed(ids));
});

const conform = (world: CliWorld, apply: boolean) => {
  const state = home(world);
  return conformT3Names(state.settings, state.managed, {
    apply,
    ...(state.accounts ? { accounts: state.accounts } : {}),
  });
};

Given("the names in T3's settings have been conformed", async (world) => {
  await conform(world, true);
});

When(
  /^the names in T3's settings are (checked|conformed)$/,
  async (world, how: string) => {
    t3(world).report = await attempt(world, () =>
      conform(world, how === 'conformed')
    );
  }
);

When(
  /^the fleet (checks|applies) the provider names of the machine "([^"]+)"$/,
  async (world, how: string, id: string) => {
    const state = home(world);
    state.check = await attempt(world, () =>
      providerNames(id, ROOT, how === 'applies', {
        t3Home: state.home,
        roster: proxy(world),
      })
    );
  }
);

Then('the check comes back as {string}', (world, status: string) => {
  expect(t3(world).check?.status).toBe(status as Check['status']);
});

// ── Login records ────────────────────────────────────────────────────────

Given('a home directory', async (world) => {
  t3(world).logins = await temporary(world, 't3-names-');
});

Given(
  "Claude's login record there names the account {string}",
  async (world, email: string) => {
    await writeFile(
      join(t3(world).logins, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } })
    );
  }
);

Given(
  "Codex's login record there holds an identity token for {string}",
  async (world, email: string) => {
    const claims = Buffer.from(JSON.stringify({ email })).toString('base64url');
    await writeFile(
      join(t3(world).logins, 'auth.json'),
      JSON.stringify({ tokens: { id_token: `x.${claims}.y` } })
    );
  }
);

When(
  /^the account signed in to "([^"]+)" is read from (that home directory|a directory that does not exist)$/,
  async (world, driver: string, place: string) => {
    const state = t3(world);
    state.account = await attempt(world, () =>
      localAccounts(
        driver,
        place === 'that home directory'
          ? state.logins
          : join(state.logins, 'missing')
      )
    );
  }
);

Then(/^the account found is (?:"([^"]+)"|none)$/, (world, email?: string) => {
  if (email) expect(t3(world).account).toBe(email);
  else expect(t3(world).account).toBeUndefined();
});
