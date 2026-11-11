import { expect } from 'bun:test';
import { parseArgs } from 'node:util';
import { wantsInteractive } from '../../../src/cli/app';
import type { CommandOutcome, CommandSpec } from '../../../src/cli/contracts';
import { execute } from '../../../src/cli/program';
import { COMMANDS, commandCatalog } from '../../../src/cli/registry';
import { resolveSettings, type Settings } from '../../../src/cli/settings';
import { packageInfo } from '../../../src/package-info';
import type { DataTable } from '../../support/gherkin';
import { argv, cli, expand, outcome, part, where } from './world';

const { Given, When, Then } = cli;

const catalog = part(() => ({
  found: [] as CommandSpec[],
  helps: [] as CommandOutcome[],
  environment: {} as Record<string, string>,
  settings: undefined as Settings | undefined,
  interactive: undefined as boolean | undefined,
}));

// ── The catalog ──────────────────────────────────────────────────────────

When('the command catalog is read', (world) => {
  catalog(world).found = COMMANDS;
});

Then('no two commands share a name', (world) => {
  const { found } = catalog(world);
  expect(new Set(found.map((entry) => entry.id)).size).toBe(found.length);
});

Then(
  'the commands that change something are, in order:',
  (world, table: DataTable) => {
    expect(
      catalog(world)
        .found.filter((entry) => entry.mutation)
        .map((entry) => entry.id)
    ).toEqual(table.list());
  }
);

Then('every command is named like one of:', (world, table: DataTable): void => {
  // `fleet-*` is any name that starts with "fleet-"; anything else is the
  // whole name.
  const named = (id: string): boolean =>
    table
      .list()
      .some((name) =>
        name.endsWith('*') ? id.startsWith(name.slice(0, -1)) : id === name
      );
  expect(catalog(world).found.every((entry) => named(entry.id))).toBe(true);
});

When(
  /^the command catalog is searched for "([^"]*)"(?: in the group "([^"]+)")?$/,
  (world, term: string, group?: string) => {
    catalog(world).found = commandCatalog(term, group ?? undefined);
  }
);

Then('it finds the command {string}', (world, id: string) => {
  expect(catalog(world).found.some((entry) => entry.id === id)).toBe(true);
});

Then(
  'every command it finds is in the group {string}',
  (world, group: string) => {
    expect(catalog(world).found.every((entry) => entry.group === group)).toBe(
      true
    );
  }
);

Then('it finds no command', (world) => {
  expect(catalog(world).found).toHaveLength(0);
});

When(
  'the operator asks every command in the catalog for {string}',
  async (world, flag: string) => {
    for (const entry of COMMANDS)
      catalog(world).helps.push(
        await execute([...entry.args, flag], where(world), world.release)
      );
  }
);

Then('each of them exits with {int}', (world, code: number) => {
  for (const help of catalog(world).helps) expect(help.exitCode).toBe(code);
});

Then('each of them prints text containing {string}', (world, part: string) => {
  for (const help of catalog(world).helps) expect(help.text).toContain(part);
});

// ── The command index ────────────────────────────────────────────────────

interface Indexed {
  id: string;
  help: string;
  execution: { default: string };
}
const indexed = (data: unknown): Indexed[] =>
  (data as { commands: Indexed[] }).commands;

Then(
  'the index says what each of these commands does when run without a flag:',
  (world, table: DataTable) => {
    for (const row of table.hashes())
      expect(
        indexed(outcome(world).data).find(
          (entry) => entry.id === row['command']
        )?.execution.default
      ).toBe(row['default']!);
  }
);

Then(
  'the help of every command in the index ends with {string}',
  (world, ending: string) => {
    expect(
      indexed(outcome(world).data).every((entry) => entry.help.endsWith(ending))
    ).toBe(true);
  }
);

Then(
  /^the package names an issue tracker, an "https:\/\/" address that ends in "\/issues"$/,
  () => {
    expect(packageInfo().issues).toMatch(/^https:\/\/\S+\/issues$/);
  }
);

// ── When the interactive menu opens ──────────────────────────────────────

When(
  /^"([^"]*)" is started (at a terminal|at a terminal in CI|without a terminal)$/,
  (world, line: string, place: string) => {
    catalog(world).interactive = wantsInteractive(
      argv(world, line),
      place !== 'without a terminal',
      place === 'at a terminal in CI'
    );
  }
);

Then(/^the interactive menu (opens|does not open)$/, (world, opens: string) => {
  expect(catalog(world).interactive).toBe(opens === 'opens');
});

// ── Settings ─────────────────────────────────────────────────────────────

Given('the environment sets:', (world, table: DataTable) => {
  catalog(world).environment = table.rowsHash();
});

When(
  'devfleet is started in the project with {string}',
  async (world, flags: string) => {
    const { values } = parseArgs({
      args: flags.split(/\s+/).map((flag) => expand(world, flag)),
      options: { workspace: { type: 'string' }, config: { type: 'string' } },
    });
    const state = catalog(world);
    state.settings = await resolveSettings(
      {
        ...(values.workspace ? { workspace: values.workspace } : {}),
        ...(values.config ? { config: values.config } : {}),
      },
      where(world).workspace,
      state.environment
    );
  }
);

Then(
  'it works in {string} with the roster {string}',
  (world, workspace: string, config: string) => {
    expect(catalog(world).settings).toEqual({
      workspace: expand(world, workspace),
      config: expand(world, config),
    });
  }
);
