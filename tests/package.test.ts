import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

interface Packed {
  files: { path: string }[];
}

// `npx @crvouga/dev-fleet` runs what `npm pack` ships: a file the CLI reads at
// run time but the tarball omits only fails once it is published.
test('the published package carries everything the CLI reads and no tests', async () => {
  const out = await Bun.$`npm pack --dry-run --json --ignore-scripts`
    .cwd(root)
    .quiet()
    .text();
  const paths = (JSON.parse(out) as Packed[])[0]!.files.map((f) => f.path);
  for (const needed of [
    'bin/devfleet.mjs',
    'src/cli/cli.ts',
    'bootstrap/fleet-manager-run.sh',
    'ansible/ubuntu/baseline.yml',
    'cliproxy/scripts/cli.py',
    'examples/fleet.json',
    'schema/fleet.schema.json',
    'src/package-info.ts',
    'mise.toml',
    'mise.lock',
  ])
    expect(paths).toContain(needed);
  expect(paths.filter((p) => /\.test\.ts$|(^|\/)tests\//.test(p))).toEqual([]);
});

test('the launcher starts the CLI through Bun and reports the manifest version', async () => {
  const result = await Bun.$`node bin/devfleet.mjs --version`
    .cwd(root)
    .quiet()
    .text();
  expect(result.trim()).toBe('0.0.0-development (unreleased source build)');
});
