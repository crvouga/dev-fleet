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
  /** Pins of this release that differ from the policy's `browser.packages`. */
  browserPackages?: Record<string, string>;
  /** The digest of the key Tailscale signs this release's suite with, when
   * it is not the policy's `tailscale.keySha256`. */
  tailscaleKeySha256?: string;
}

export const UBUNTU_RELEASES: readonly UbuntuRelease[] = policy.releases;

/** The package pins of one release: the policy's, with the release's own
 * pins over them (as tasks/release.yml combines them for Ansible). */
export function packagePins(
  release: UbuntuRelease | undefined
): Record<string, string> {
  return { ...policy.packages, ...release?.packages };
}

/** The browser library pins of one release, combined the same way. */
export function browserPackagePins(
  release: UbuntuRelease | undefined
): Record<string, string> {
  return { ...policy.browser.packages, ...release?.browserPackages };
}

/** The Tailscale version and the digest of the key that signs one release's
 * suite (as tasks/release.yml selects it for Ansible). */
export function tailscalePins(release: UbuntuRelease | undefined): {
  version: string;
  keySha256: string;
} {
  return {
    version: policy.tailscale.version,
    keySha256: release?.tailscaleKeySha256 ?? policy.tailscale.keySha256,
  };
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
