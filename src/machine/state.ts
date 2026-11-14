import { readFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FleetUsageError } from '../errors';
import { record } from '../config';

export interface Enrollment {
  version: 1;
  id: string;
  approvedRevision: string;
  appliedRevision?: string;
  previousRevision?: string;
  /** The revision each worker last converged to, by fleet id. A worker
   * keeps its progress when the fleet as a whole is not ready.
   */
  workers?: Record<string, string>;
  /** Tombstones: when each retired worker left the fleet, by fleet id. */
  retired?: Record<string, string>;
}

export const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** The manager's enrollment from the file that held it before it moved into
 * the fleet state (src/state/enrollment.ts). Nothing writes this file now.
 */
export async function readEnrollment(root: string): Promise<Enrollment | null> {
  try {
    const path = join(root, 'enrollment.json');
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4096) throw new Error();
    const enrollment = parseEnrollment(
      JSON.parse(await readFile(path, 'utf8'))
    );
    if (!enrollment) throw new Error();
    return enrollment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FleetUsageError(
      'Invalid enrollment state. Restore the private enrollment.json backup; do not enroll a replacement using another machine’s identity.'
    );
  }
}

export async function ensurePrivateRoot(root: string): Promise<void> {
  for (let path = root; dirname(path) !== path; path = dirname(path)) {
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new FleetUsageError(
          'Fleet state paths cannot contain symbolic links.'
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function validWorkers(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      Object.entries(value).every(
        ([id, revision]) =>
          /^[a-z][a-z0-9-]{0,62}$/.test(id) && isRevision(revision)
      ))
  );
}

function validRetired(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      Object.entries(value).every(
        ([id, at]) =>
          /^[a-z][a-z0-9-]{0,62}$/.test(id) &&
          typeof at === 'string' &&
          !Number.isNaN(Date.parse(at))
      ))
  );
}

/** A valid enrollment record, or null. */
export function parseEnrollment(data: unknown): Enrollment | null {
  if (!record(data) || data['version'] !== 1) return null;
  if (
    typeof data['id'] !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(data['id'])
  )
    return null;
  return isRevision(data['approvedRevision']) &&
    ['appliedRevision', 'previousRevision'].every(
      (key) => data[key] === undefined || isRevision(data[key])
    ) &&
    validWorkers(data['workers']) &&
    validRetired(data['retired'])
    ? (data as unknown as Enrollment)
    : null;
}
