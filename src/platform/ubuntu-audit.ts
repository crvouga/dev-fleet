import type { Runner } from '../types';
import { packagePins, UBUNTU_RELEASES, ubuntuRelease } from './ubuntu-release';

export interface UbuntuAudit {
  supported: boolean;
  release: string | null;
  architecture: string | null;
  packages: Record<string, string>;
  desktop: boolean;
  services: Record<string, boolean>;
  passwordlessSudo: boolean;
  rebootPending: boolean;
}
// Every package any accepted release pins, so one audit serves them all.
const PACKAGES = [
  ...new Set([
    ...UBUNTU_RELEASES.flatMap((release) => Object.keys(packagePins(release))),
    'tailscale',
  ]),
];

/** Read-only audit: never emit package sources, environment, accounts or raw errors. */
export async function auditUbuntu(run: Runner): Promise<UbuntuAudit> {
  const release = await run(['cat', '/etc/os-release']);
  const arch = await run(['dpkg', '--print-architecture']);
  const packages = await run([
    'dpkg-query',
    '-W',
    '-f=${Package}\t${Version}\n',
    ...PACKAGES,
  ]);
  const services: Record<string, boolean> = {};
  for (const name of ['ssh', 'tailscaled', 'beszel-agent', 'docker']) {
    services[name] = (
      await run(['systemctl', 'is-active', `${name}.service`])
    ).ok;
  }
  const version =
    /^VERSION_ID="?([0-9]+\.[0-9]+)"?$/m.exec(release.stdout)?.[1] ?? null;
  const reported = arch.stdout.trim();
  const accepted = ubuntuRelease(version);
  const architecture = accepted?.architectures.includes(reported)
    ? reported
    : null;
  return {
    supported:
      release.ok &&
      /^ID=ubuntu$/m.test(release.stdout) &&
      accepted !== undefined &&
      architecture !== null,
    release: version,
    architecture,
    packages: packageVersions(packages.stdout),
    desktop: (await run(['test', '-d', '/usr/share/xsessions'])).ok,
    services,
    passwordlessSudo: (await run(['sudo', '-n', 'true'])).ok,
    rebootPending: (await run(['test', '-f', '/var/run/reboot-required'])).ok,
  };
}
function packageVersions(output: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const [name, version] = line.split('\t');
    if (
      name &&
      PACKAGES.includes(name) &&
      version &&
      /^[a-zA-Z0-9.+:~_-]{1,100}$/.test(version)
    )
      versions[name] = version;
  }
  return versions;
}
