import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DataTable } from '../../support/gherkin';
import type { Account } from '../../../src/agents/accounts';
import { accountInstanceId, accountDriver } from '../../../src/t3/accounts';
import { modelsCheck } from '../../../src/t3/models';
import { ide, type IdeWorld } from './world';

const { Given, When } = ide;

interface Models {
  accounts: Account[] | null;
  required: Record<string, string[]>;
}
const models = new WeakMap<IdeWorld, Models>();
const of = (world: IdeWorld): Models => {
  let value = models.get(world);
  if (!value) models.set(world, (value = { accounts: [], required: {} }));
  return value;
};

const PROVIDERS: Record<string, string> = {
  codex: 'codex',
  claude: 'claude',
  opencode: 'antigravity',
};
const list = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const file = (world: IdeWorld, name: string): string => {
  mkdirSync(join(world.t3Home, 'userdata'), { recursive: true });
  return join(world.t3Home, 'userdata', name);
};
const readJson = (path: string): Record<string, unknown> =>
  existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {};

Given('the proxy serves these models:', (world, table: DataTable) => {
  of(world).accounts = table.hashes().map((row) => ({
    tool: row['tool']!,
    email: row['account']!,
    prefix: `${PROVIDERS[row['tool']!]}-${row['account']}`,
    models: list(row['models']!),
  }));
});

Given('the proxy does not answer', (world) => {
  of(world).accounts = null;
});

Given('T3 holds the instances of every account the proxy serves', (world) => {
  const instances = Object.fromEntries(
    (of(world).accounts ?? []).map((account) => [
      accountInstanceId(account),
      { driver: accountDriver(account.tool), enabled: true, config: {} },
    ])
  );
  writeFileSync(
    file(world, 'settings.json'),
    JSON.stringify({ providerInstances: instances })
  );
});

Given(
  "T3's catalogue for the driver {string} is {string}",
  (world, driver: string, catalogue: string) => {
    const path = file(world, 'model-manifest.json');
    const manifest = readJson(path) as {
      manifest?: { currentModels?: Record<string, string[]> };
    };
    writeFileSync(
      path,
      JSON.stringify({
        fetchedAtMs: 0,
        manifest: {
          ...manifest.manifest,
          currentModels: {
            ...manifest.manifest?.currentModels,
            [driver]: list(catalogue),
          },
        },
      })
    );
  }
);

Given(
  'the instance of {string} adds the custom model {string}',
  (world, email: string, model: string) => {
    const path = file(world, 'settings.json');
    const settings = readJson(path) as {
      providerInstances: Record<string, { config: Record<string, unknown> }>;
    };
    const account = of(world).accounts!.find(
      (candidate) => candidate.email === email
    )!;
    settings.providerInstances[accountInstanceId(account)]!.config[
      'customModels'
    ] = [{ slug: model, name: model }];
    writeFileSync(path, JSON.stringify(settings));
  }
);

Given(
  'the fleet requires the model {string} for {string}',
  (world, model: string, tool: string) => {
    of(world).required[tool] = [model];
  }
);

When('the models T3 offers are checked', async (world) => {
  const accounts = of(world).accounts;
  world.checks = [
    await modelsCheck({
      t3Home: world.t3Home,
      roster: async () => {
        if (!accounts)
          throw new Error('The CLI proxy did not list its models.');
        return accounts;
      },
      required: of(world).required,
    }),
  ];
});
