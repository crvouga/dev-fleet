import { afterAll } from 'bun:test';
import { runFeatures } from '../support/gherkin';
import { FreshBoxWorld, freshBox } from './steps';
import './fleet-steps';
import { discardBoxes } from './support/boxes';

// The whole worker toolchain is downloaded: run on request, and on every pull
// request (`DEVFLEET_TEST_FRESH_BOX=required` there).
//   DEVFLEET_TEST_FRESH_BOX=1 bun test features/fresh-box
// DEVFLEET_TEST_FRESH_BOX_FEATURE names one feature file (`fleet`,
// `fresh-box`) to run alone: CI runs each in a job of its own, side by side.
runFeatures({
  directory: import.meta.dir,
  only: process.env['DEVFLEET_TEST_FRESH_BOX_FEATURE'] || undefined,
  steps: [freshBox],
  world: () => new FreshBoxWorld(),
  skip: () => !process.env['DEVFLEET_TEST_FRESH_BOX'],
  timeoutMs: 180_000,
});

// Removing the machine can take longer than a hook's default five seconds.
afterAll(discardBoxes, 300_000);
