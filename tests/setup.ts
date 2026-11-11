import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Tests run against the example fleet, never a real machine's configuration.
process.env['DEVFLEET_CONFIG'] = resolve(
  import.meta.dir,
  '../examples/fleet.json'
);

// Nor a real machine's fleet state or bucket: each run gets an empty directory.
const state = mkdtempSync(join(tmpdir(), 'devfleet-test-state-'));
process.env['DEVFLEET_STATE'] = join(state, 'state');
process.env['DEVFLEET_BUCKET'] = join(state, 'bucket.json');
process.on('exit', () => rmSync(state, { recursive: true, force: true }));
