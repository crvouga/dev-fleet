import { runFeatures } from '../support/gherkin';
import { IdeWorld, ide } from './steps/world';
import './steps/seam';
import './steps/profile';
import './steps/models';
import './steps/manager';
import './steps/pairing';
import './steps/work-in-progress';

runFeatures({
  directory: import.meta.dir,
  steps: [ide],
  world: () => new IdeWorld(),
  skip: (tags) => tags.includes('@posix') && process.platform === 'win32',
  timeoutMs: 30_000,
});
