import { runFeatures } from '../support/gherkin';
import { AccountsWorld, accounts } from './steps';

runFeatures({
  directory: import.meta.dir,
  steps: [accounts],
  world: () => new AccountsWorld(),
});
