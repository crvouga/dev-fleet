import { diskGc } from './disk-gc';
import { installer } from './installer';
import { packageSmoke } from './package-smoke';
import { pins } from './pins';
import { notes } from './release-notes';
import { publishing } from './publishing';
import { toolchain } from './toolchain';
import { worker } from './worker';
import { BootstrapWorld, common } from './world';

export { BootstrapWorld };
/** Every step of this area. */
export const bootstrap = [
  common,
  publishing,
  installer,
  toolchain,
  worker,
  diskGc,
  pins,
  packageSmoke,
  notes,
];
