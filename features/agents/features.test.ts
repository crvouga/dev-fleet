import { runFeatures } from '../support/gherkin';
import { AgentsWorld, agents } from './steps';

runFeatures({
  directory: import.meta.dir,
  steps: agents,
  world: () => new AgentsWorld(),
});
