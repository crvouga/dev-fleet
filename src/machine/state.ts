import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FleetUsageError } from '../errors';
import { FleetLockError } from './lock-error';
import { record } from '../config';

export interface Enrollment {
  version: 1;
  id: string;
  approvedRevision: string;
  appliedRevision?: string;
  previousRevision?: string;
}

export const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export async function readEnrollment(root: string): Promise<Enrollment | null> {
  try {
    const path = join(root, 'enrollment.json');
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4096) throw new Error();
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!validEnrollment(data)) throw new Error();
    return data as unknown as Enrollment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FleetUsageError(
      'Invalid enrollment state. Restore the private enrollment.json backup; do not enroll a replacement using another machine’s identity.'
    );
  }
}

export async function saveEnrollment(
  root: string,
  state: Enrollment
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'enrollment.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A lock directory with no readable owner is only abandoned after this long,
 * so a run that has just created it but not yet written `owner.json` is safe. */
const OWNERLESS_LOCK_GRACE_MS = 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** True only when the lock is provably abandoned: its recorded owner process
 * no longer exists (killed, crashed, closed terminal, reboot), or it never
 * recorded one and is older than the grace period. Anything uncertain is held. */
async function lockAbandoned(lock: string): Promise<boolean> {
  try {
    const owner: unknown = JSON.parse(
      await readFile(join(lock, 'owner.json'), 'utf8')
    );
    if (record(owner) && Number.isInteger(owner['pid']))
      return !processAlive(owner['pid'] as number);
  } catch {
    // Missing or unreadable owner: fall through to the age check.
  }
  try {
    return Date.now() - (await stat(lock)).mtimeMs > OWNERLESS_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

/** Removes an abandoned lock. The rename is atomic, so when several managers
 * race to recover it exactly one wins; the others simply retry the lock. */
async function reclaimAbandonedLock(lock: string): Promise<boolean> {
  if (!(await lockAbandoned(lock))) return false;
  const aside = `${lock}.abandoned-${randomUUID()}`;
  try {
    await rename(lock, aside);
  } catch {
    return true; // Someone else already recovered it; retry.
  }
  await rm(aside, { recursive: true, force: true });
  return true;
}

/** Bundles are written next to the lock and removed in a `finally`, which a
 * killed run never reaches. Holding the lock means none is in use. */
async function sweepTransferBundles(root: string): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[]))
    if (/^transfer-[0-9a-f-]+\.bundle$/.test(name))
      await rm(join(root, name), { force: true });
}

/** Fail closed while a sync is genuinely running; recover automatically from
 * a lock whose owner process is gone so an interrupted run never needs manual
 * cleanup. Never steals a lock from a still-running installer. */
export async function withMachineLock<T>(
  root: string,
  operation: () => Promise<T>
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'sync.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new FleetUsageError(
          'Cannot create manager lock; inspect private state-directory permissions and free disk space.'
        );
      if (attempt < 3 && (await reclaimAbandonedLock(lock))) continue;
      throw new FleetLockError(
        'Fleet sync is locked. Inspect running installers before removing an abandoned sync.lock directory, then rerun.'
      );
    }
  }
  try {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    await sweepTransferBundles(root);
    return await operation();
  } finally {
    await rm(lock, { recursive: true });
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

function validEnrollment(data: unknown): boolean {
  if (!record(data) || data['version'] !== 1) return false;
  if (
    typeof data['id'] !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(data['id'])
  )
    return false;
  return (
    isRevision(data['approvedRevision']) &&
    ['appliedRevision', 'previousRevision'].every(
      (key) => data[key] === undefined || isRevision(data[key])
    )
  );
}
