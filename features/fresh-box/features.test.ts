import { afterAll } from 'bun:test';
import { runFeatures } from '../support/gherkin';
import { FreshBoxWorld, discardBox, freshBox } from './steps';

// The whole worker toolchain is downloaded: run on request, and on every pull
// request (`DEVFLEET_TEST_FRESH_BOX=required` there).
//   DEVFLEET_TEST_FRESH_BOX=1 bun test features/fresh-box
runFeatures({
  directory: import.meta.dir,
  steps: [freshBox],
  world: () => new FreshBoxWorld(),
  skip: () => !process.env['DEVFLEET_TEST_FRESH_BOX'],
  timeoutMs: 180_000,
});

// Removing the machine can take longer than a hook's default five seconds.
afterAll(discardBox, 120_000);
