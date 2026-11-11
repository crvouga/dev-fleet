import { runFeatures } from '../support/gherkin';
import { CoreWorld, core } from './steps';

runFeatures({
  directory: import.meta.dir,
  steps: [core],
  world: () => new CoreWorld(),
  // `@posix` needs a POSIX shell; `@linux` needs flock(1).
  skip: (tags) =>
    (tags.includes('@posix') && process.platform === 'win32') ||
    (tags.includes('@linux') && process.platform !== 'linux'),
  timeoutMs: 20_000,
});
