import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const SKIPPED =
  /^(cliproxy\/vendor\/|\.mise\/|bun\.lock$|mise\.lock$)|\.(png|svg)$/;

async function tracked(): Promise<[string, string][]> {
  const paths = (await Bun.$`git -C ${root} ls-files`.text()).split('\n');
  return paths
    .filter((path) => path && !SKIPPED.test(path))
    .map((path) => [path, readFileSync(resolve(root, path), 'utf8')]);
}

function offenders(
  files: [string, string][],
  pattern: RegExp,
  allowed: RegExp
): string[] {
  const found = new Set<string>();
  for (const [path, text] of files)
    for (const match of text.match(pattern) ?? [])
      if (!allowed.test(match)) found.add(`${path}: ${match}`);
  return [...found].sort();
}

// dev-fleet is for anyone's machines. A fleet's own accounts, hostnames,
// tailnet and repository belong in that fleet's fleet.json, never here.
test('the tree names no real account, tailnet or foreign repository', async () => {
  const files = await tracked();
  expect(
    offenders(
      files,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
      /@(example\.(com|org|test|invalid)|b\.c|home\.ts\.net|github\.com|127\.0\.0\.1|users\.noreply\.github\.com|\d[\d.]*)$/
    )
  ).toEqual([]);
  expect(
    offenders(
      files,
      /\b[a-z0-9-]+\.ts\.net\b/g,
      /^(example|fixture|home|second|tailnet|tail0a1b2c)\.ts\.net$/
    )
  ).toEqual([]);
  expect(
    offenders(
      files,
      /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/g,
      /\/(dev|developer|someone|x|fixture|fleettest|me|name|profile)$/
    )
  ).toEqual([]);
});

// A consumer can assert its own names never leak into a fork or a patch:
//   DEVFLEET_FORBIDDEN='my-host,mydomain.dev' bun test tests/identity.test.ts
test('names listed in DEVFLEET_FORBIDDEN appear nowhere', async () => {
  const names = (process.env['DEVFLEET_FORBIDDEN'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const hits: string[] = [];
  for (const [path, text] of await tracked())
    for (const name of names)
      if (text.toLowerCase().includes(name)) hits.push(`${path}: ${name}`);
  expect(hits).toEqual([]);
});
