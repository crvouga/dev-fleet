import { runFeatures } from '../support/gherkin';
import { StateWorld, state } from './steps';
import { skipped } from './support/requirements';

// Tags (support/requirements.ts decides what is skipped):
//   @litestream  runs the Litestream that mise.toml pins. Skipped where
//                `mise which litestream` finds none.
//   @s3          talks to the throwaway S3 service DEVFLEET_TEST_S3 names,
//                such as http://127.0.0.1:5000. Skipped where it names none.
//   @required    runs only where DEVFLEET_TEST_LITESTREAM=required, and
//                fails when a piece the two tags above need is missing.
//   @slow        ten times the timeout below.
// With DEVFLEET_TEST_LITESTREAM=required (the Fleet state job in CI) nothing
// is skipped: a scenario that lacks Litestream or the S3 service fails.
runFeatures({
  directory: import.meta.dir,
  steps: [state],
  world: () => new StateWorld(),
  skip: skipped,
  timeoutMs: 12_000,
});
