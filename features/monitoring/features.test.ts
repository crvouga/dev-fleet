import { runFeatures } from '../support/gherkin';
import { MonitoringWorld, monitoring } from './steps/world';
import './steps/agents';
import './steps/hub';

runFeatures({
  directory: import.meta.dir,
  steps: [monitoring],
  world: () => new MonitoringWorld(),
  // Takes a real flock(1), which macOS does not have.
  skip: (tags) => tags.includes('@linux') && process.platform !== 'linux',
});
