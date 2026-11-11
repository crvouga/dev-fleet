import policy from '../../ansible/ubuntu/policy.json';
import type { Runner } from '../types';

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
const PACKAGES = [...Object.keys(policy.packages), 'tailscale'];

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
  const architecture = /^(amd64|arm64)\s*$/.exec(arch.stdout)?.[1] ?? null;
  return {
    supported:
      release.ok &&
      /^ID=ubuntu$/m.test(release.stdout) &&
      version === '26.04' &&
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
