import { runFeatures } from '../support/gherkin';
import { MachinesWorld, machines } from './steps/world';
import './steps/ansible';
import './steps/launchd';
import './steps/manager';
import './steps/platforms';
import './steps/t3';
import './steps/workers';

runFeatures({
  directory: import.meta.dir,
  steps: [machines],
  world: () => new MachinesWorld(),
  // plutil is macOS's own: the manager job of CI runs these on macOS.
  skip: (tags) => tags.includes('@macos') && process.platform !== 'darwin',
});
