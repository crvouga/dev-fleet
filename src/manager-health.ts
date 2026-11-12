import { homedir } from 'node:os';
import { join } from 'node:path';
import macos from '../ansible/macos/policy.json';
import type { Check, Runner } from './types';

/** Read-only measurements of the manager's operating system and disk, from
 * the floors `ansible/macos/policy.json` declares. Nothing a command printed
 * is reported: only what was concluded from it.
 */
export async function managerHealth(
  run: Runner,
  home = homedir()
): Promise<Check[]> {
  return [
    await managerRelease(run),
    await managerUpdates(run),
    await managerDisk(run),
    await containerWatchdog(run, home),
  ];
}

/** The manager runs at least the macOS release the policy names. */
export async function managerRelease(run: Runner): Promise<Check> {
  const id = 'manager:release';
  const result = await run(['sw_vers', '-productVersion']);
  const major = /^(\d+)(?:\.\d+)*$/.exec(result.stdout.trim())?.[1];
  if (!result.ok || major === undefined)
    return { id, status: 'skip', summary: 'MANAGER_RELEASE_UNOBSERVED' };
  if (Number(major) >= macos.minimumMajorVersion)
    return {
      id,
      status: 'pass',
      summary: `The manager runs macOS ${major}, at least the required ${macos.minimumMajorVersion}.`,
    };
  return {
    id,
    status: 'fail',
    summary: `MANAGER_RELEASE_UNSUPPORTED macOS ${major}, below ${macos.minimumMajorVersion}`,
    remedy: {
      action: `Update the manager to macOS ${macos.minimumMajorVersion} or later in System Settings > General > Software Update, then rerun fleet-sync.`,
    },
  };
}

/** Pending macOS updates warn, and so does one that waits for a restart.
 * `--no-scan` reads the list macOS already has: nothing is downloaded.
 */
export async function managerUpdates(run: Runner): Promise<Check> {
  const id = 'manager:updates';
  const result = await run(['softwareupdate', '--list', '--no-scan'], {
    timeoutMs: 60_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!result.ok)
    return { id, status: 'skip', summary: 'MANAGER_UPDATES_UNOBSERVED' };
  const pending = (output.match(/^\s*\* Label:/gm) ?? []).length;
  const restart = /Action:\s*restart/i.test(output);
  if (pending === 0)
    return { id, status: 'pass', summary: 'No macOS update is pending.' };
  return {
    id,
    status: 'warn',
    summary: restart
      ? `MANAGER_RESTART_PENDING ${pending} updates, at least one waits for a restart`
      : `MANAGER_UPDATES_PENDING ${pending} updates`,
    remedy: {
      action:
        'Install the pending updates in System Settings > General > Software Update at a time no worker depends on the manager, then rerun fleet-sync.',
    },
  };
}

const MIB = 1024;
const GIB = 1024 ** 3;

/** Free space on the data volume, and the space Docker Desktop holds. */
export async function managerDisk(run: Runner): Promise<Check> {
  const id = 'manager:disk';
  const df = await run(['df', '-Pk', '/System/Volumes/Data']);
  const kib = Number(df.stdout.split('\n')[1]?.trim().split(/\s+/)[3]);
  if (!df.ok || !Number.isFinite(kib))
    return { id, status: 'skip', summary: 'MANAGER_DISK_UNOBSERVED' };
  const free = Math.floor(kib / MIB);
  const docker = await dockerBytes(run);
  const dockerGiB = docker === null ? null : docker / GIB;
  const held =
    dockerGiB === null ? '' : `; Docker holds ${dockerGiB.toFixed(1)} GiB`;
  const remedy = {
    action:
      'Free space on the manager: docker system prune removes unused images and build cache; empty large caches and downloads.',
  };
  if (free < macos.disk.failFreeMiB)
    return {
      id,
      status: 'fail',
      summary: `MANAGER_DISK_FULL ${free} MiB free${held}`,
      remedy,
    };
  if (free < macos.disk.warnFreeMiB)
    return {
      id,
      status: 'warn',
      summary: `MANAGER_DISK_LOW ${free} MiB free${held}`,
      remedy,
    };
  if (dockerGiB !== null && dockerGiB > macos.disk.dockerWarnGiB)
    return {
      id,
      status: 'warn',
      summary: `MANAGER_DOCKER_DISK_LARGE ${free} MiB free${held}`,
      remedy,
    };
  return {
    id,
    status: 'pass',
    summary: `${Math.floor(free / MIB)} GiB free on the data volume${held}.`,
  };
}

const UNITS: Record<string, number> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
};

/** The bytes of images, containers, volumes and build cache, or null when
 * Docker does not answer.
 */
async function dockerBytes(run: Runner): Promise<number | null> {
  const result = await run(
    ['docker', 'system', 'df', '--format', '{{.Size}}'],
    { timeoutMs: 30_000 }
  );
  if (!result.ok) return null;
  let total = 0;
  for (const line of result.stdout.split('\n')) {
    const match = /^([\d.]+)\s*([kKMGT]?B)$/.exec(line.trim());
    if (match) total += Number(match[1]) * (UNITS[match[2]!] ?? 0);
  }
  return total;
}

/** What the container watchdog remembers (ansible/monitoring/container-watchdog.py). */
type WatchdogMemory = Record<
  string,
  { restarts?: number[]; capped?: number | null }
>;

/** A container the watchdog stopped restarting is a restart storm: it fails,
 * and one it restarted within the hour warns.
 */
export async function containerWatchdog(
  run: Runner,
  home: string,
  now = Date.now()
): Promise<Check> {
  const id = 'manager:container-watchdog';
  const result = await run([
    'cat',
    join(home, 'Library/Caches/dev-fleet/container-watchdog.json'),
  ]);
  let memory: WatchdogMemory;
  try {
    memory = JSON.parse(result.stdout) as WatchdogMemory;
  } catch {
    memory = {};
  }
  if (!result.ok || typeof memory !== 'object' || memory === null)
    return { id, status: 'skip', summary: 'CONTAINER_WATCHDOG_UNOBSERVED' };
  const hour = (time: unknown) =>
    typeof time === 'number' && now / 1000 - time < 3600;
  const names = Object.keys(memory).filter((name) =>
    /^[A-Za-z0-9_.-]{1,128}$/.test(name)
  );
  const capped = names.filter((name) => hour(memory[name]?.capped));
  const restarted = names.filter((name) =>
    (memory[name]?.restarts ?? []).some(hour)
  );
  const remedy = {
    action:
      'Read the container watchdog log (~/Library/Application Support/dev-fleet/container-watchdog/watchdog.log) and the container logs, fix the cause, then docker restart the container.',
  };
  if (capped.length)
    return {
      id,
      status: 'fail',
      summary: `CONTAINER_RESTART_STORM ${capped.join(' ')}`,
      remedy,
    };
  if (restarted.length)
    return {
      id,
      status: 'warn',
      summary: `CONTAINER_RESTARTED_UNHEALTHY ${restarted.join(' ')}`,
      remedy,
    };
  return {
    id,
    status: 'pass',
    summary: 'No container stayed unhealthy in the last hour.',
  };
}
