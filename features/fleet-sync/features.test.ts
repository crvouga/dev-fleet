import { spawnSync } from 'node:child_process';
import { runFeatures } from '../support/gherkin';
import { FleetSyncWorld, fleetSync } from './steps';

// @vault runs a Vault development server with the vault mise.toml pins.
// Skipped where none is on PATH, unless DEVFLEET_TEST_VAULT=required (CI).
const vault =
  process.env['DEVFLEET_TEST_VAULT'] === 'required' ||
  spawnSync('vault', ['version'], { stdio: 'ignore' }).status === 0;

runFeatures({
  directory: import.meta.dir,
  steps: [fleetSync],
  world: () => new FleetSyncWorld(),
  skip: (tags) => tags.includes('@vault') && !vault,
  timeoutMs: 30_000,
});
