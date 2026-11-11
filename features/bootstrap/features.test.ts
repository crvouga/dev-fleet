import { existsSync } from 'node:fs';
import { runFeatures } from '../support/gherkin';
import { BootstrapWorld, bootstrap } from './steps';

// What a tagged scenario needs and this machine may not have.
const missing: Record<string, boolean> = {
  '@linux': process.platform !== 'linux',
  '@bash': !existsSync('/bin/bash'),
  '@zsh': !existsSync('/bin/zsh'),
};

runFeatures({
  directory: import.meta.dir,
  steps: bootstrap,
  world: () => new BootstrapWorld(),
  skip: (tags) => tags.some((tag) => missing[tag]),
});
