import { installer } from './installer';
import { publishing } from './publishing';
import { toolchain } from './toolchain';
import { worker } from './worker';
import { BootstrapWorld, common } from './world';

export { BootstrapWorld };
/** Every step of this area. */
export const bootstrap = [common, publishing, installer, toolchain, worker];
