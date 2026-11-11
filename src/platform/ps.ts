import { spawnSync } from 'node:child_process';

import type { ProcessInfo } from './types';

// `args` goes last because it is the only column that may contain spaces.
const PS_ARGS = [
  '-A',
  '-ww',
  '-o',
  'pid=,ppid=,pgid=,uid=,rss=,pcpu=,stat=,args=',
];
const ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/;
const PS_MAX_BUFFER = 64 * 1024 * 1024;

export function parsePsOutput(stdout: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = ROW.exec(line);
    if (m === null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      uid: Number(m[4]),
      rssKb: Number(m[5]),
      cpu: Number(m[6]),
      state: m[7] ?? '',
      command: (m[8] ?? '').trim(),
    });
  }
  return rows;
}

/** One `ps` call for the whole table (BSD + procps compatible). */
export function psProcesses(): ProcessInfo[] | null {
  const r = spawnSync('ps', PS_ARGS, {
    encoding: 'utf8',
    maxBuffer: PS_MAX_BUFFER,
    // Force `.` decimals in pcpu regardless of the user's locale.
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return parsePsOutput(r.stdout);
}
