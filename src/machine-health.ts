import policy from '../ansible/ubuntu/policy.json';
import type { DoctorCheck } from './doctor-check';

/** Machine health sample parsed from `net/remote-probe.sh` output. */
export type HealthSample = {
  readonly ncpu?: number;
  readonly load?: number;
  readonly memFreePct?: number;
  readonly swapPct?: number;
  readonly diskMb?: number;
  /** Free inodes on the home filesystem, as a percentage of all of them. */
  readonly inodesFreePct?: number;
  /** 1 when the clock is synchronised to a time source, 0 when not. */
  readonly clockSynced?: number;
  /** 1 when a time service is enabled, 0 when not. */
  readonly timeService?: number;
  /** The machine's clock, in seconds since the epoch. */
  readonly epoch?: number;
};

const PROBE_KEYS = {
  ncpu: 'ncpu',
  load: 'load',
  memfree: 'memFreePct',
  swap: 'swapPct',
  diskmb: 'diskMb',
  inodefree: 'inodesFreePct',
  ntpsync: 'clockSynced',
  ntp: 'timeService',
  epoch: 'epoch',
} as const;

function isProbeKey(key: string): key is keyof typeof PROBE_KEYS {
  return Object.hasOwn(PROBE_KEYS, key);
}

/** Parse `key=value` probe lines; unknown keys and non-numbers are ignored. */
export function parseProbe(output: string): HealthSample {
  const sample: Record<string, number> = {};
  for (const line of output.split(/\r?\n/)) {
    const [key, value] = line.trim().split('=', 2);
    if (key === undefined || value === undefined || !isProbeKey(key)) continue;
    const n = Number(value);
    if (value.length > 0 && Number.isFinite(n)) sample[PROBE_KEYS[key]] = n;
  }
  return sample;
}

const LABELS = {
  load: 'CPU load',
  memory: 'Memory',
  disk: 'Disk space',
  inodes: 'Free inodes',
};

function check(
  id: keyof typeof LABELS,
  severity: DoctorCheck['severity'],
  detail: string,
  fix?: string
): DoctorCheck {
  return { id, label: LABELS[id], severity, detail, ...(fix ? { fix } : {}) };
}

/** CPU load relative to core count: ≥2× per core fails, ≥1× warns. */
export function loadCheck(s: HealthSample, alias: string): DoctorCheck | null {
  if (s.ncpu === undefined || s.load === undefined || s.ncpu <= 0) return null;
  const ratio = s.load / s.ncpu;
  const what = `load ${s.load} on ${s.ncpu} cores (${ratio.toFixed(1)}x)`;
  if (ratio >= 2) {
    return check(
      'load',
      'fail',
      `overloaded, ${what}. This makes SSH and T3 time out.`,
      `Find the culprit: ssh ${alias} 'ps aux | sort -rk3 | head'`
    );
  }
  if (ratio >= 1) return check('load', 'warn', `busy, ${what}`);
  return check('load', 'pass', what);
}

/** RAM + swap pressure. */
export function memoryCheck(s: HealthSample): DoctorCheck | null {
  if (s.memFreePct === undefined || s.swapPct === undefined) return null;
  const what = `${s.memFreePct}% RAM free, swap ${s.swapPct}% used`;
  if (s.swapPct >= 90 && s.memFreePct < 15) {
    return check('memory', 'fail', `exhausted, ${what}`);
  }
  if (s.memFreePct < 10 || s.swapPct >= 80) {
    return check('memory', 'warn', `tight, ${what}`);
  }
  return check('memory', 'pass', what);
}

/** Free disk: <2 GB fails (VS Code server, git, worktrees break), <10 GB warns. */
export function diskCheck(diskMb: number | undefined): DoctorCheck | null {
  if (diskMb === undefined) return null;
  if (diskMb < 2048) {
    return check(
      'disk',
      'fail',
      `almost full, ${diskMb} MB free. VS Code server, git and T3 worktrees will break.`
    );
  }
  if (diskMb < 10_240) return check('disk', 'warn', `low, ${diskMb} MB free`);
  return check('disk', 'pass', `${Math.floor(diskMb / 1024)} GB free`);
}

/** Free inodes, with the floors `policy.json` gives the disk guard: a
 * filesystem with free bytes and no free inodes fails every write.
 */
export function inodesCheck(
  inodesFreePct: number | undefined,
  floors = INODE_FLOORS
): DoctorCheck | null {
  if (inodesFreePct === undefined) return null;
  const what = `${inodesFreePct}% of inodes free`;
  if (inodesFreePct < floors.failPercent)
    return check(
      'inodes',
      'fail',
      `INODES_EXHAUSTED, ${what}. Every new file fails although bytes are free.`,
      'Remove idle dependency trees and worktrees: the hourly disk collector does so under pressure, or delete them by hand.'
    );
  if (inodesFreePct < floors.warnPercent)
    return check('inodes', 'warn', `low, ${what}`);
  return check('inodes', 'pass', what);
}

const INODE_FLOORS = {
  warnPercent: policy.resourceSafety.inodeWarnFreePercent,
  failPercent: policy.resourceSafety.inodeFailFreePercent,
};

export function healthChecks(s: HealthSample, alias: string): DoctorCheck[] {
  return [
    loadCheck(s, alias),
    memoryCheck(s),
    diskCheck(s.diskMb),
    inodesCheck(s.inodesFreePct),
  ].filter((c): c is DoctorCheck => c !== null);
}
