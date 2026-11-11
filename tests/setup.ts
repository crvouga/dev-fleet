import { resolve } from 'node:path';

// Tests run against the example fleet, never a real machine's configuration.
process.env['DEVFLEET_CONFIG'] = resolve(
  import.meta.dir,
  '../examples/fleet.json'
);
