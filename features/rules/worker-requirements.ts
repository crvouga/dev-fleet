import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ubuntu from '../../ansible/ubuntu/policy.json';
import type { DataTable } from '../support/gherkin';
import { rules, type RulesWorld } from './steps';

const { When, Then } = rules;
const root = resolve(import.meta.dir, '../..');
const read = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8');

interface Requirement {
  text: string;
  /** The check the row names, or null when it names none. */
  check: string | null;
  codes: string[];
}
interface Page {
  text: string;
  requirements: Requirement[];
}
const pages = new WeakMap<RulesWorld, Page>();
const page = (world: RulesWorld): Page => pages.get(world)!;

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
const spans = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

/** Every row of every table whose header has a Check and a Failure code
 * column.
 */
function requirements(text: string): Requirement[] {
  const found: Requirement[] = [];
  let columns: { check: number; code: number } | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) {
      columns = null;
      continue;
    }
    const row = cells(line);
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!columns) {
      const check = row.indexOf('Check');
      const code = row.indexOf('Failure code');
      columns = check >= 0 && code >= 0 ? { check, code } : null;
      // Not a requirement table: skip its rows.
      if (!columns) columns = { check: -1, code: -1 };
      continue;
    }
    if (columns.check < 0) continue;
    found.push({
      text: row[0]!,
      check: spans(row[columns.check] ?? '')[0] ?? null,
      codes: spans(row[columns.code] ?? ''),
    });
  }
  return found;
}

interface Registered {
  id: string;
  requirement?: boolean;
}
const registry = (): Registered[] =>
  (JSON.parse(read('schema/check-ids.json')) as { checks: Registered[] })
    .checks;

/** A registered ID, where `*` stands for one name. */
const registered = (id: string): boolean =>
  registry().some((entry) =>
    new RegExp(
      `^${entry.id.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`
    ).test(id)
  );

const runbookCodes = (): Set<string> =>
  new Set(
    [...read('docs/runbooks.md').matchAll(/^- `([A-Z][A-Z0-9_]+)`:/gm)].map(
      (match) => match[1]!
    )
  );

/** Why rows are refused; empty when none is. */
function refusals(rows: Requirement[]): string[] {
  const codes = runbookCodes();
  return rows.flatMap((row) => [
    ...(row.check === null
      ? ['a row names no check']
      : registered(row.check)
        ? []
        : [`${row.check} is not registered`]),
    ...row.codes
      .filter((code) => !codes.has(code))
      .map((code) => `${code} has no runbook entry`),
  ]);
}

When(
  'the requirements in {string} are read',
  (world: RulesWorld, path: string) => {
    const text = read(path);
    pages.set(world, { text, requirements: requirements(text) });
  }
);

When('this requirement is read:', (world: RulesWorld, text: string) => {
  pages.set(world, { text, requirements: requirements(text) });
});

Then(
  'it lists at least {int} requirements',
  (world: RulesWorld, count: number) => {
    expect(page(world).requirements.length).toBeGreaterThanOrEqual(count);
  }
);

Then('each names a check the check-ID registry holds', (world: RulesWorld) => {
  expect(
    refusals(page(world).requirements).filter(
      (reason) => !reason.endsWith('has no runbook entry')
    )
  ).toEqual([]);
});

Then(
  'each code it names has an entry in {string}',
  (world: RulesWorld, path: string) => {
    expect(path).toBe('docs/runbooks.md');
    expect(
      refusals(page(world).requirements).filter((reason) =>
        reason.endsWith('has no runbook entry')
      )
    ).toEqual([]);
  }
);

Then('it is refused because {string}', (world: RulesWorld, reason: string) => {
  expect(refusals(page(world).requirements)).toEqual([reason]);
});

Then(
  'every check the registry marks as a worker requirement is named by one of them',
  (world: RulesWorld) => {
    const named = new Set(page(world).requirements.map((row) => row.check));
    const marked = registry()
      .filter((entry) => entry.requirement)
      .map((entry) => entry.id);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.filter((id) => !named.has(id))).toEqual([]);
  }
);

Then(
  'they name every release the Ubuntu policy accepts, with its codename and architectures',
  (world: RulesWorld) => {
    const text = page(world).text;
    for (const release of ubuntu.releases) {
      expect(text).toContain(`**${release.release}** (${release.codename})`);
      for (const architecture of release.architectures)
        expect(text).toContain(`**${architecture}**`);
    }
  }
);

Then(
  'they name the minimum worker size of the Ubuntu policy',
  (world: RulesWorld) => {
    const { cpus, memoryMiB, diskMiB } = ubuntu.sizing.minimumWorker;
    const text = page(world).text;
    expect(text).toContain(`**${cpus} CPUs**`);
    expect(text).toContain(`**${memoryMiB} MiB** of memory`);
    expect(text).toContain(`**${diskMiB} MiB** root filesystem`);
  }
);

Then(
  'each of these documents links to {string}:',
  (_world: RulesWorld, target: string, table: DataTable) => {
    expect(
      table.list().filter((path) => !read(path).includes(`${target})`))
    ).toEqual([]);
  }
);
