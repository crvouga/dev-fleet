import platforms from '../../ansible/platforms.json';
import { UBUNTU_WORKER, workerPlatform } from '../platform/ubuntu-worker';

/** One POSIX probe for every worker, four lines: family, release, CPU and
 * the environment it runs in (`wsl`, `container` or `machine`, a physical
 * or virtual machine of its own). Read-only, and it needs nothing installed.
 * `root` moves the files it reads, for a stand-in; workers use `/`.
 */
export function platformProbe(root = ''): string {
  return `sh -c '${[
    `if [ -r ${root}/etc/os-release ]; then . ${root}/etc/os-release; printf "%s\\n%s\\n" "$ID" "$VERSION_ID"; else printf "%s\\n\\n" "$(uname -s)"; fi`,
    'uname -m',
    `if grep -qiE "microsoft|wsl" ${root}/proc/sys/kernel/osrelease 2>/dev/null; then echo wsl`,
    `elif [ -e ${root}/.dockerenv ] || [ -e ${root}/run/.containerenv ] || systemd-detect-virt --container --quiet 2>/dev/null; then echo container`,
    'else echo machine; fi',
  ].join('; ')}'`;
}
export const PLATFORM_PROBE = platformProbe();

export interface PlatformBaseline {
  id: 'ubuntu:release' | 'platform:environment';
  supported: boolean;
  summary: string;
}

/** A worker is an accepted release of a worker platform on one of that
 * release's CPUs. The check keeps its ID and its refusal: Ubuntu is the only
 * worker platform, and anything else is refused as not that baseline. */
export function evaluatePlatform(probe: string): PlatformBaseline {
  const [family, version, cpu] = probe.split('\n').map((line) => line.trim());
  const platform = workerPlatform(family);
  const release = platform?.release(version);
  const supported =
    platform !== undefined &&
    release !== undefined &&
    platform.kernelArchitectures(release).includes(cpu ?? '');
  return {
    id: 'ubuntu:release',
    supported,
    summary: supported
      ? `${platform.label} ${release.release} and supported CPU architecture observed.`
      : (platform ?? UBUNTU_WORKER).mismatch,
  };
}

/** Environments the support matrix (ansible/platforms.json) refuses, by the
 * word the probe prints for them. */
const REFUSED = new Map(
  platforms.rows.flatMap((row) =>
    'environment' in row && row.status === 'refused'
      ? [[row.environment, row.platform] as const]
      : []
  )
);

/** WSL2 and containers run an Ubuntu userland without systemd, a display
 * manager or a power policy of their own; they are refused by name. */
export function evaluateEnvironment(probe: string): PlatformBaseline {
  const environment = probe.split('\n')[3]?.trim() ?? '';
  const refused = REFUSED.get(environment);
  const supported = environment === 'machine';
  return {
    id: 'platform:environment',
    supported,
    summary: supported
      ? 'A machine of its own observed: not WSL2 and not a container.'
      : `WORKER_ENVIRONMENT_UNSUPPORTED: ${refused ?? 'unknown environment'}`,
  };
}
