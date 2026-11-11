import { runFeatures } from '../support/gherkin';
import { RulesWorld, rules } from './steps';

runFeatures({
  directory: import.meta.dir,
  steps: [rules],
  world: () => new RulesWorld(),
  timeoutMs: 30_000,
});
