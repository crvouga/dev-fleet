import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The most a scheduled job's log may hold; a longer one keeps its newest
 * quarter.
 */
export const SCHEDULE_LOG_BYTES = 1024 * 1024;

/** Caps the schedule's own logs (`<label>.out.log`, `<label>.err.log`) at the
 * start of every scheduled run. launchd and systemd append to them, so the
 * newest lines are what is kept. Nothing else in the directory is touched.
 */
export function capScheduleLogs(
  directory: string,
  limit = SCHEDULE_LOG_BYTES
): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^[a-z0-9-]+\.(out|err)\.log$/.test(name)) continue;
    const path = join(directory, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size <= limit) continue;
      const kept = readFileSync(path).subarray(stat.size - limit / 4);
      const start = kept.indexOf(10) + 1;
      writeFileSync(path, kept.subarray(start), { mode: 0o600 });
    } catch {
      // A log that cannot be capped is capped by the next run.
    }
  }
}
