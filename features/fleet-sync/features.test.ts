import { runFeatures } from '../support/gherkin';
import { FleetSyncWorld, fleetSync } from './steps';

runFeatures({
  directory: import.meta.dir,
  steps: [fleetSync],
  world: () => new FleetSyncWorld(),
  timeoutMs: 30_000,
});
