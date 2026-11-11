import { bundleProbe } from '../../../src/transport';

let bundled: Promise<string> | undefined;

/** The probe the manager sends to a worker, bundled from the current source.
 * Bundling is slow and gives the same text every time, so it happens once.
 */
export const bundledProbe = (): Promise<string> => (bundled ??= bundleProbe());
