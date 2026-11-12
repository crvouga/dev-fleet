import policy from '../../ansible/ubuntu/policy.json';

/** One Ubuntu release workers may run. The accepted releases are named once,
 * in ansible/ubuntu/policy.json; nothing else spells a release or codename. */
export interface UbuntuRelease {
  release: string;
  codename: string;
  /** Debian architecture names, as `dpkg --print-architecture` reports them. */
  architectures: string[];
  /** Pins of this release that differ from the policy's `packages`. */
  packages?: Record<string, string>;
}

export const UBUNTU_RELEASES: readonly UbuntuRelease[] = policy.releases;

/** The package pins of one release: the policy's, with the release's own
 * pins over them (as tasks/release.yml combines them for Ansible). */
export function packagePins(
  release: UbuntuRelease | undefined
): Record<string, string> {
  return { ...policy.packages, ...release?.packages };
}

/** `uname -m` for each Debian architecture name. */
const KERNEL_ARCHITECTURES: Record<string, string> = {
  amd64: 'x86_64',
  arm64: 'aarch64',
};

export function ubuntuRelease(
  version: string | null | undefined
): UbuntuRelease | undefined {
  return UBUNTU_RELEASES.find((entry) => entry.release === version);
}

/** The `uname -m` names one release runs on. */
export function kernelArchitectures(release: UbuntuRelease): string[] {
  return release.architectures.map(
    (name) => KERNEL_ARCHITECTURES[name] ?? name
  );
}
