import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
      found.push(path);
  }
  return found;
}

// Fleet is the lower layer: the CLI and Workstation may use it, never the
// other way round. Shared code moves into this package instead.
test('fleet imports neither Workstation nor the personal CLI', async () => {
  const offenders: string[] = [];
  for (const file of await sources(root)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(
      /(?:from|import)\s*\(?\s*['"]((?:\.\.\/)+)(workstation|personal-cli)\//g
    ))
      offenders.push(`${relative(root, file)} -> ${match[2]}`);
  }
  expect(offenders).toEqual([]);
});
