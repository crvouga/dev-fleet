import platforms from '../../ansible/platforms.json';
import { UBUNTU_WORKER, workerPlatform } from '../platform/ubuntu-worker';
import { belowMinimum, MINIMUM_WORKER } from '../worker-sizing';
import { machineClass } from './machine-class';

/** One POSIX probe for every worker, nine lines: family, release, CPU, the
 * environment it runs in (`wsl`, `container` or `machine`, a physical or
 * virtual machine of its own), the hypervisor systemd-detect-virt names
 * (`none` on bare metal, `unknown` when it cannot tell), the CPU count, all
 * memory in MiB, the size of the root filesystem in MiB, and its clock in
 * seconds since the epoch, which the manager compares with its own.
 * Read-only, and it needs nothing installed. `root` moves the files it
 * reads, for a stand-in; workers use `/`.
 */
export function platformProbe(root = ''): string {
  return `sh -c '${[
    `if [ -r ${root}/etc/os-release ]; then . ${root}/etc/os-release; printf "%s\\n%s\\n" "$ID" "$VERSION_ID"; else printf "%s\\n\\n" "$(uname -s)"; fi`,
    'uname -m',
    `if grep -qiE "microsoft|wsl" ${root}/proc/sys/kernel/osrelease 2>/dev/null; then echo wsl`,
    `elif [ -e ${root}/.dockerenv ] || [ -e ${root}/run/.containerenv ] || systemd-detect-virt --container --quiet 2>/dev/null; then echo container`,
    'else echo machine; fi',
    'v=$(systemd-detect-virt --vm 2>/dev/null)',
    'echo "${v:-unknown}"',
    'nproc 2>/dev/null || echo',
    // Each size prints its own line, empty when unread, so the clock after
    // them stays on the ninth.
    `m=$(awk "/^MemTotal:/{print int(\\$2/1024)}" ${root}/proc/meminfo 2>/dev/null)`,
    'echo "$m"',
    `d=$(df -Pk ${root}/ 2>/dev/null | awk "NR==2{print int(\\$2/1024)}")`,
    'echo "$d"',
    'date -u +%s.%N',
  ].join('; ')}'`;
}
export const PLATFORM_PROBE = platformProbe();

export interface PlatformBaseline {
  id: 'ubuntu:release' | 'platform:environment' | 'platform:worker-size';
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

/** The clock the probe read, in seconds since the epoch, or undefined. */
export function probedClock(probe: string): number | undefined {
  const line = probe.split('\n')[8]?.trim() ?? '';
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

const line = (probe: string, index: number): string =>
  probe.split('\n')[index]?.trim() ?? '';

/** The class of machine the probe found: physical, virtual or unsupported
 * (a container or WSL2), recorded for every worker. A worker that cannot
 * say which hypervisor it runs on is taken as physical, so nothing that
 * applies to a physical machine is left out. */
export function evaluateMachineClass(probe: string): {
  id: 'platform:machine-class';
  summary: string;
} {
  const environment = line(probe, 3);
  const virtualization = line(probe, 4) || 'unknown';
  const found = machineClass(environment, virtualization);
  return {
    id: 'platform:machine-class',
    summary:
      found === 'virtual'
        ? `Virtual machine (${virtualization}): checks of firmware power recovery and of a lid do not apply.`
        : found === 'physical'
          ? `Physical machine (systemd-detect-virt reported ${virtualization}).`
          : `Unsupported: ${environment || 'unknown environment'}.`,
  };
}

const BELOW_MINIMUM = 'WORKER_SIZE_BELOW_MINIMUM';

/** The machine against the stated minimum worker size (`sizing` in the
 * Ubuntu policy), before anything is installed; null when the probe did not
 * report a size. */
export function evaluateSize(probe: string): PlatformBaseline | null {
  const [cpus, memoryMiB, diskMiB] = [5, 6, 7].map((index) =>
    Number(line(probe, index) || NaN)
  );
  if (![cpus, memoryMiB, diskMiB].every((value) => Number.isInteger(value)))
    return null;
  const lacks = belowMinimum({
    cpus: cpus!,
    memoryMiB: memoryMiB!,
    diskMiB: diskMiB!,
  });
  return {
    id: 'platform:worker-size',
    supported: lacks.length === 0,
    summary: lacks.length
      ? `${BELOW_MINIMUM}: ${lacks.join(', ')}`
      : `${cpus} CPUs, ${memoryMiB} MiB of memory and a ${diskMiB} MiB root filesystem: at least the minimum worker (${MINIMUM_WORKER.cpus} CPUs, ${MINIMUM_WORKER.memoryMiB} MiB, ${MINIMUM_WORKER.diskMiB} MiB).`,
  };
}
