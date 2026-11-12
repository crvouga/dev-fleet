import type { Runner } from '../types';
import type { WorkerFeatures } from '../worker-features';
import {
  browserPackagePins,
  kernelArchitectures,
  packagePins,
  tailscalePins,
  UBUNTU_RELEASES,
  ubuntuRelease,
} from './ubuntu-release';
import type { WorkerPlatform, WorkerRelease } from './worker-platform';

/** Ubuntu: every release ansible/ubuntu/policy.json accepts, converged by
 * the playbooks under ansible/ubuntu. A release's differences are data of
 * its policy entry (tasks/release.yml selects it from the facts). */
export const UBUNTU_WORKER: WorkerPlatform = {
  family: 'ubuntu',
  label: 'Ubuntu',
  policy: 'ansible/ubuntu/policy.json',
  playbooks: 'ansible/ubuntu',
  releases: UBUNTU_RELEASES,
  mismatch: 'UBUNTU_BASELINE_MISMATCH',
  packageManager: 'apt',
  packagePins: (release) => packagePins(ubuntuRelease(release?.release)),
  browserPackagePins: (release) =>
    browserPackagePins(ubuntuRelease(release?.release)),
  tailscalePins: (release) => tailscalePins(ubuntuRelease(release?.release)),
  serviceManager: 'systemd',
  sessionModel: 'systemd-user-linger',
  release: (version) => ubuntuRelease(version),
  kernelArchitectures: (release: WorkerRelease) =>
    kernelArchitectures(ubuntuRelease(release.release) ?? release),
  // Loaded when used: the platform probe reads this module on the manager,
  // and the host checks pull in what only a worker runs.
  hostChecks: async (
    user: string,
    run: Runner,
    features?: WorkerFeatures,
    powerRecoveryNote?: string
  ) =>
    (await import('../worker-host-checks')).workerHostChecks(
      user,
      run,
      features,
      powerRecoveryNote
    ),
};

/** Every platform a worker may run. A machine of any other family is
 * refused by the first check that can tell (docs/support-matrix.md). */
export const WORKER_PLATFORMS: readonly WorkerPlatform[] = [UBUNTU_WORKER];

/** The platform of an `ID` from /etc/os-release, when workers may run it. */
export function workerPlatform(
  family: string | null | undefined
): WorkerPlatform | undefined {
  return WORKER_PLATFORMS.find((platform) => platform.family === family);
}
