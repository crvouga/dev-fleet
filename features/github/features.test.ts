import { runFeatures } from '../support/gherkin';
import './steps/steps';
import { GithubWorld, github } from './steps/world';

runFeatures({
  directory: import.meta.dir,
  steps: [github],
  world: () => new GithubWorld(),
});
