import { runFeatures } from '../support/gherkin';
import { ExposureWorld, exposure } from './steps';

runFeatures({
  directory: import.meta.dir,
  steps: [exposure],
  world: () => new ExposureWorld(),
});
