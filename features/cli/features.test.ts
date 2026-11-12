import { runFeatures } from '../support/gherkin';
import { CliWorld, cli } from './steps/world';
import './steps/program';
import './steps/catalog';
import './steps/roster';
import './steps/machine';
import './steps/t3';
import './steps/node-sync';
import './steps/repair';
import './steps/menu';
import './steps/watch';
import './steps/validate';
import './steps/usage';
import './steps/leftovers';

runFeatures({
  directory: import.meta.dir,
  steps: [cli],
  world: () => new CliWorld(),
  // What POSIX file modes and symbolic links promise does not hold on Windows.
  skip: (tags) => tags.includes('@posix') && process.platform === 'win32',
  timeoutMs: 30_000,
});
