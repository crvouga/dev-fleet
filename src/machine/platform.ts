import platforms from '../../ansible/platforms.json';
import { kernelArchitectures, ubuntuRelease } from '../platform/ubuntu-release';

/** One POSIX probe for every worker, five lines: family, release, CPU, the
 * environment it runs in (`wsl`, `container` or `machine`, a physical or
 * virtual machine of its own) and its clock in seconds since the epoch, which
 * the manager compares with its own. Read-only, and it needs nothing
 * installed.
 * `root` moves the files it reads, for a stand-in; workers use `/`.
 */
export function platformProbe(root = ''): string {
  return `sh -c '${[
    `if [ -r ${root}/etc/os-release ]; then . ${root}/etc/os-release; printf "%s\\n%s\\n" "$ID" "$VERSION_ID"; else printf "%s\\n\\n" "$(uname -s)"; fi`,
    'uname -m',
    `if grep -qiE "microsoft|wsl" ${root}/proc/sys/kernel/osrelease 2>/dev/null; then echo wsl`,
    `elif [ -e ${root}/.dockerenv ] || [ -e ${root}/run/.containerenv ] || systemd-detect-virt --container --quiet 2>/dev/null; then echo container`,
    'else echo machine; fi',
    'date -u +%s.%N',
  ].join('; ')}'`;
}
export const PLATFORM_PROBE = platformProbe();

export interface PlatformBaseline {
  id: 'ubuntu:release' | 'platform:environment';
  supported: boolean;
  summary: string;
}

/** A worker is an accepted Ubuntu release on one of that release's CPUs. */
export function evaluatePlatform(probe: string): PlatformBaseline {
  const [family, version, cpu] = probe.split('\n').map((line) => line.trim());
  const release = family === 'ubuntu' ? ubuntuRelease(version) : undefined;
  const supported =
    release !== undefined && kernelArchitectures(release).includes(cpu ?? '');
  return {
    id: 'ubuntu:release',
    supported,
    summary: supported
      ? `Ubuntu ${release.release} and supported CPU architecture observed.`
      : 'UBUNTU_BASELINE_MISMATCH',
  };
}

/** The clock the probe read, in seconds since the epoch, or undefined. */
export function probedClock(probe: string): number | undefined {
  const line = probe.split('\n')[4]?.trim() ?? '';
  // GNU date prints nanoseconds; another date prints a literal N.
  const match = /^(\d{9,})(\.\d+)?/.exec(line);
  return match ? Number(match[1]! + (match[2] ?? '')) : undefined;
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
