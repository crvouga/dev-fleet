import { runFeatures } from '../support/gherkin';
import { OrchestrationWorld, orchestration } from './steps';

runFeatures({
  directory: import.meta.dir,
  steps: [orchestration],
  world: () => new OrchestrationWorld(),
  // `@posix`: the scenario runs a POSIX shell.
  skip: (tags) => tags.includes('@posix') && process.platform === 'win32',
  timeoutMs: 30_000,
});
