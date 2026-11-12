import { afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// No test touches a real machine's fleet state or bucket: each run gets an
// empty directory.
const state = mkdtempSync(join(tmpdir(), 'devfleet-test-state-'));
process.env['DEVFLEET_STATE'] = join(state, 'state');
process.env['DEVFLEET_BUCKET'] = join(state, 'bucket.json');
// `bun test` does not emit 'exit'; the directory goes when the run ends.
afterAll(() => rmSync(state, { recursive: true, force: true }));

// Tests run against the example fleet, never a real machine's configuration,
// and without the bucket the example names: a test that replicates anywhere
// names its own target.
const { state: _bucket, ...example } = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../examples/fleet.json'), 'utf8')
) as Record<string, unknown>;
process.env['DEVFLEET_CONFIG'] = join(state, 'fleet.json');
writeFileSync(
  process.env['DEVFLEET_CONFIG'],
  JSON.stringify(example, null, 2) + '\n'
);
// The manager lease names this process, never the machine it runs on.
process.env['DEVFLEET_MANAGER_HOLDER'] = 'machine-under-test';
// Nor with a developer's own bucket credentials.
delete process.env['DEVFLEET_BUCKET_ACCESS_KEY_ID'];
delete process.env['DEVFLEET_BUCKET_SECRET_ACCESS_KEY'];
