import { runFeatures } from '../support/gherkin';
import { RulesWorld, rules } from './steps';
import './contracts';
import './heartbeat-steps';

runFeatures({
  directory: import.meta.dir,
  steps: [rules],
  world: () => new RulesWorld(),
  timeoutMs: 30_000,
});
