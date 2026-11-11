import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { receiptDirectory } from '../platform/ansible-receipt';
import type { Check } from '../types';

/** A verified inference or agent session is re-proven at least this often. */
export const VERIFY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface VerifyCache {
  directory?: string;
  now?: number;
  /** Ignore cached results (a live probe failed, or a full check was asked). */
  bypass?: boolean;
}

/** Digest of everything a result depends on (never secrets). */
export function cacheKey(...parts: (string | object)[]): string {
  const hash = createHash('sha256');
  for (const part of parts)
    hash
      .update(typeof part === 'string' ? part : JSON.stringify(part))
      .update('\0');
  return hash.digest('hex');
}

/** Digest of source files, so a code change re-verifies. */
export async function sourceKey(paths: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const path of [...paths].sort())
    hash
      .update(path)
      .update('\0')
      .update(await readFile(path).catch(() => ''));
  return hash.digest('hex');
}

/** Warm verification: a passing check with an unchanged key is reused until it
 * ages out. Only clean passes are stored; a failure, a skip or a quota-limited
 * pass (`reuse` false) clears the entry so the next sync checks it again.
 */
export async function cachedCheck(
  name: string,
  key: string,
  compute: () => Promise<Check>,
  options: VerifyCache & { reuse?: (check: Check) => boolean } = {}
): Promise<Check> {
  const directory = options.directory ?? join(receiptDirectory(), 'verify');
  const path = join(directory, `${name.replace(/[^a-z0-9-]/gi, '_')}.json`);
  const now = options.now ?? Date.now();
  if (!options.bypass) {
    const hit = await fresh(path, key, now);
    if (hit) return hit;
  }
  const check = await compute();
  const reusable =
    check.status === 'pass' && (options.reuse ? options.reuse(check) : true);
  try {
    if (!reusable) await rm(path, { force: true });
    else {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        path,
        JSON.stringify({ version: 1, key, checkedAt: now, check }) + '\n',
        { mode: 0o600 }
      );
    }
  } catch {
    /* A missing cache entry only means the next sync verifies again. */
  }
  return check;
}

async function fresh(
  path: string,
  key: string,
  now: number
): Promise<Check | null> {
  try {
    const entry = JSON.parse(await readFile(path, 'utf8')) as {
      version?: unknown;
      key?: unknown;
      checkedAt?: unknown;
      check?: Check;
    };
    if (
      entry.version !== 1 ||
      entry.key !== key ||
      typeof entry.checkedAt !== 'number' ||
      now - entry.checkedAt < 0 ||
      now - entry.checkedAt >= VERIFY_MAX_AGE_MS ||
      entry.check?.status !== 'pass'
    )
      return null;
    const minutes = Math.round((now - entry.checkedAt) / 60_000);
    return {
      ...entry.check,
      summary: `${entry.check.summary} (verified ${minutes}m ago; re-proven every 6h or on any change)`,
    };
  } catch {
    return null;
  }
}
