import { runFeatures } from '../support/gherkin';
import { AgentsWorld, agents } from './steps';
import { ansibleAvailable } from './support/ansible';

runFeatures({
  directory: import.meta.dir,
  steps: agents,
  world: () => new AgentsWorld(),
  skip: (tags) => tags.includes('@ansible') && !ansibleAvailable,
});
