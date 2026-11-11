import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config';
import { parseDefinition } from '../definition';
import { parseEnrollment } from '../machine/state';
import { databasePath, definitionPath, legacyHome, stateRoot } from './paths';
import { DOCUMENTS, writeDocument, type DocumentName } from './store';

/** Where each document was kept before the fleet state existed. A machine
 * that has no state database yet still reads them; its first change moves
 * all of them into the state, and nothing reads or writes them afterwards.
 */
const LEGACY: Record<DocumentName, string> = {
  // The copy fleet-sync installs; it stays the launchers' copy afterwards.
  definition: '.config/dev-fleet/fleet.json',
  roster: '.config/personal/fleet.json',
  enrollment: '.local/share/personal/fleet/manager/enrollment.json',
};

export function legacyPath(
  name: DocumentName,
  env = process.env,
  home = homedir()
): string | null {
  const earlier = legacyHome(env, home);
  return earlier ? join(earlier, LEGACY[name]) : null;
}

/** The earlier file's text, or null: when there is no such file, and once
 * this machine has a state database, which then holds everything.
 */
export function readLegacy(
  name: DocumentName,
  env = process.env,
  home = homedir()
): string | null {
  const path = legacyPath(name, env, home);
  if (!path || existsSync(databasePath(stateRoot(env, home)))) return null;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Whether a document's text is what its readers accept. */
const VALID: Record<DocumentName, (value: unknown) => boolean> = {
  definition: (value) => Boolean(parseDefinition(value)),
  roster: (value) => Boolean(parseConfig(value)),
  enrollment: (value) => parseEnrollment(value) !== null,
};

function valid(name: DocumentName, text: string): boolean {
  try {
    return VALID[name](JSON.parse(text));
  } catch {
    return false;
  }
}

/** Run before the first change on a machine. A state database that does not
 * exist yet starts with what the machine kept in files, so creating it never
 * hides a document the machine still depends on. Returns what was moved.
 */
export function adoptEarlier(
  env = process.env,
  home = homedir()
): DocumentName[] {
  const root = stateRoot(env, home);
  if (existsSync(databasePath(root))) return [];
  const named = env['DEVFLEET_CONFIG'];
  const earlier = DOCUMENTS.map((name) => ({
    name,
    text: readLegacy(name, env, home),
  }));
  const adopted: DocumentName[] = [];
  for (const { name, text } of earlier) {
    // A configuration kept in a file of your own stays there.
    if (name === 'definition' && named && named !== definitionPath(root))
      continue;
    if (text === null || !valid(name, text)) continue;
    writeDocument(databasePath(root), name, text);
    adopted.push(name);
  }
  return adopted;
}
