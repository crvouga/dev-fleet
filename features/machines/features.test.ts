import { runFeatures } from '../support/gherkin';
import { MachinesWorld, machines } from './steps/world';
import './steps/ansible';
import './steps/manager';
import './steps/platforms';
import './steps/t3';
import './steps/workers';

runFeatures({
  directory: import.meta.dir,
  steps: [machines],
  world: () => new MachinesWorld(),
});
