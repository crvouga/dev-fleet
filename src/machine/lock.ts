// CLI-only: the worker probe and launchers import machine/state, never this.
import { Database } from 'bun:sqlite';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FleetUsageError } from '../errors';
import { FleetLockError } from './lock-error';
import { record } from '../config';

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

/** Removes the lock only while it is still the one this run wrote. */
async function releaseLock(lock: string, owner: string): Promise<void> {
  const current = await readFile(join(lock, 'owner.json'), 'utf8').catch(
    () => null
  );
  if (current === owner) await rm(lock, { recursive: true, force: true });
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
  operation: () => Promise<T>,
  judged: () => Promise<void> = async () => {},
  reclaimed: () => Promise<void> = async () => {}
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'sync.lock');
  // The observation is not authority to delete anything. Features pause here
  // to reproduce a second command overtaking the first.
  if (await lockAbandoned(lock)) await judged();
  const guard = new Database(join(root, 'sync.guard.sqlite'));
  try {
    try {
      guard.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_BUSY')
        throw new FleetLockError(
          'Fleet sync is locked by another command. Retry when it finishes.'
        );
      throw error;
    }
    // Keep the historical directory for compatibility with running releases.
    // Only the kernel lock holder may judge, remove or create this directory.
    if (await lockAbandoned(lock)) {
      await rm(lock, { recursive: true, force: true });
      await reclaimed();
    }
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new FleetLockError(
          'Fleet sync is locked. Wait for the running installer to finish.'
        );
      throw new FleetUsageError(
        'Cannot create manager lock; inspect private state-directory permissions and free disk space.'
      );
    }
    const owner =
      JSON.stringify({
        version: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        run: randomUUID(),
      }) + '\n';
    try {
      await writeFile(join(lock, 'owner.json'), owner, {
        flag: 'wx',
        mode: 0o600,
      });
      await sweepTransferBundles(root);
      return await operation();
    } finally {
      await releaseLock(lock, owner);
    }
  } finally {
    // Closing releases the OS lock, including on an exception. A killed
    // process releases it in the kernel. Never unlink this stable lock file.
    guard.close();
  }
}
