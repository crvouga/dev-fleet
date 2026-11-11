import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { FleetUsageError } from '../errors';
import { adoptEarlier, readLegacy } from './legacy';
import { databasePath, stateRoot } from './paths';
import { readDocument, writeDocument } from './store';

/** The roster kept in the fleet state: what `--config` means when no file is
 * named. A named file (`--config PATH`, `.fleet.local.json`) stays a file.
 */
export const STATE_ROSTER = 'state:roster';

/** The roster's text, or null when there is none. */
export async function readRosterText(
  path: string,
  env = process.env,
  home = homedir()
): Promise<string | null> {
  if (path === STATE_ROSTER)
    return (
      readDocument(databasePath(stateRoot(env, home)), 'roster') ??
      readLegacy('roster', env, home)
    );
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new FleetUsageError(
        'Roster must be a regular file smaller than 1 MiB; symlinks are not supported.'
      );
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeRosterText(
  path: string,
  text: string,
  env = process.env,
  home = homedir()
): Promise<void> {
  if (path === STATE_ROSTER) {
    adoptEarlier(env, home);
    writeDocument(databasePath(stateRoot(env, home)), 'roster', text);
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
  }
}
