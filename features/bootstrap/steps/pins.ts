import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { update, type Change } from '../../../bootstrap/pins';
import { steps, type DataTable } from '../../support/gherkin';
import { part, type BootstrapWorld } from './world';

export const pins = steps<BootstrapWorld>();
const { Given, When, Then } = pins;

const tracked = readFileSync(
  resolve(import.meta.dir, '../../../mise.toml'),
  'utf8'
);
/** A digest a table writes as a short number, as the 64 hex digits upstream gives. */
const sha = (short: string): string => short.padStart(64, '0');
const quoted = (text: string): string[] =>
  [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
const set = (text: string, name: string, value: string): string =>
  text.replace(new RegExp(`^${name} = ".*"$`, 'm'), `${name} = "${value}"`);

/** The tracked mise.toml and a stand-in for GitHub. */
const upstream = part(() => ({
  text: tracked,
  tags: {} as Record<string, string[]>,
  sums: {} as Record<string, string>,
  files: {} as Record<string, string>,
  change: undefined as Change | undefined,
}));

Given('mise.toml pins mise {string}', (world, version: string) => {
  upstream(world).text = set(tracked, 'min_version', version);
});

Given('mise.toml pins T3 Code {string}', (world, version: string) => {
  upstream(world).text = set(tracked, 't3_version', version);
});

Given(
  /^(\S+) has the releases (.+)$/,
  (world, repository: string, tags: string) => {
    upstream(world).tags[repository] = quoted(tags);
  }
);

Given(
  'the SHASUMS256.txt of {string} lists:',
  (world, tag: string, table: DataTable) => {
    upstream(world).sums[tag] = table
      .hashes()
      .map(({ digest, archive }) => `${sha(digest!)}  ${archive}`)
      .join('\n');
  }
);

Given('these release files hash to:', (world, table: DataTable) => {
  for (const { file, digest } of table.hashes())
    upstream(world).files[file!] = sha(digest!);
});

When('the {string} pin is updated', async (world, pin: string) => {
  const state = upstream(world);
  await world.attempt(async () => {
    state.change = await update(pin, state.text, {
      tags: async (repository) => state.tags[repository] ?? [],
      text: async (url) => {
        const tag = /\/download\/([^/]+)\/SHASUMS256\.txt$/.exec(url)?.[1];
        return state.sums[tag ?? ''] ?? '';
      },
      sha256: async (url) =>
        state.files[url.split('/download/')[1] ?? ''] ?? '',
    });
  });
});

Then(
  'the pin moved from {string} to {string}',
  (world, from: string, to: string) => {
    expect(world.refusal).toBeUndefined();
    const { change } = upstream(world);
    expect([change?.from, change?.to]).toEqual([from, to]);
  }
);

Then('the pin is current at {string}', (world, version: string) => {
  expect(world.refusal).toBeUndefined();
  const { change } = upstream(world);
  expect([change?.from, change?.to]).toEqual([version, version]);
});

Then('mise.toml now reads:', (world, table: DataTable) => {
  const text = upstream(world).change!.text;
  for (const { name, value } of table.hashes()) {
    const expected = name!.endsWith('_sha256') ? sha(value!) : value;
    expect(new RegExp(`^${name} = "(.*)"$`, 'm').exec(text)?.[1]).toBe(
      expected
    );
  }
});

Then('mise.toml is unchanged', (world) => {
  const state = upstream(world);
  expect(state.change!.text).toBe(state.text);
});
