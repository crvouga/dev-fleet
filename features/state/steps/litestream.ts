import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetState } from '../../../src/cli/fleet-state';
import { runCommand } from '../../../src/runner';
import { parseBucket } from '../../../src/state/bucket';
import { requirements } from '../support/requirements';
import { write } from './common';
import { WHO, phrase, state } from './world';

const { Given, Then } = state;

// The Litestream that mise.toml pins, replicating to a directory and to a
// throwaway S3 service: no machine and no real bucket.

Then('the pinned Litestream is installed', () => {
  expect(requirements.installed).toBe(true);
});
Then('DEVFLEET_TEST_S3 names an S3 service', () => {
  expect(requirements.s3).toBeTruthy();
});

Given(
  'managers {string} and {string} replicate to one directory with the pinned Litestream',
  (world, first: string, second: string) => {
    for (const name of [first, second]) {
      const manager = world.manager(name);
      manager.bucket = parseBucket({ directory: world.remote });
      manager.run = runCommand;
    }
  }
);

Given(
  'managers {string} and {string} run the pinned Litestream',
  (world, first: string, second: string) => {
    for (const name of [first, second]) world.manager(name).run = runCommand;
  }
);

// ── The S3 service ───────────────────────────────────────────────────────

Given('a new bucket on the S3 service', async (world) => {
  const origin = requirements.s3;
  if (!origin) throw new Error('DEVFLEET_TEST_S3 names no S3 service.');
  const bucket = `fleet-state-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const made = (await fetch(`${origin}/${bucket}`, { method: 'PUT' })).ok;
  world.s3 = { origin, bucket, made };
});

Then('the S3 service made the new bucket', (world) => {
  expect(world.s3?.made).toBe(true);
});

Then(
  'the new bucket holds objects, every one under {string}',
  async (world, prefix: string) => {
    const { origin, bucket } = world.s3!;
    const listing = await (
      await fetch(`${origin}/${bucket}?list-type=2`)
    ).text();
    const keys = [...listing.matchAll(/<Key>([^<]+)<\/Key>/g)].map(
      (match) => match[1]!
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith(prefix))).toBe(true);
  }
);

Then(
  phrase(
    '"([^"]+)" in the state directory of ',
    WHO,
    ' does not contain "([^"]+)"'
  ),
  (world, file: string, name: string | undefined, text: string) => {
    expect(
      readFileSync(join(world.manager(name).root, file), 'utf8')
    ).not.toContain(text);
  }
);

Given(
  phrase(
    '"([^"]+)" on ',
    WHO,
    ' holds what "fleet-state --export" prints there, with "([^"]+)" renamed "([^"]+)"'
  ),
  async (world, path: string, name: string | undefined, from: string, to) => {
    const manager = world.manager(name);
    const exported = await fleetState(
      { export: true },
      { run: manager.run, env: manager.env, home: manager.home, ask: null }
    );
    write(
      world.expand(path, manager),
      exported.text!.replaceAll(from, to as string)
    );
  }
);
