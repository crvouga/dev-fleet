import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { record } from '../config';

/** The file a project keeps its fleet configuration in. */
export const PROJECT_CONFIG = 'fleet.json';

/** Another tool's fleet.json is not this one: a fleet configuration is a JSON
 * object that names a manager. Whether it is a valid one is said later, with
 * the file's path, by whatever reads it.
 */
function fleetConfiguration(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return record(value) && record(value['manager']);
  } catch {
    return false;
  }
}

/** The fleet.json of the project a command is run from: the closest one in
 * the working directory or above it, or null.
 */
export function projectConfig(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, PROJECT_CONFIG);
    if (fleetConfiguration(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** A fleet is a project of your own: a fleet.json in Git, and the devfleet
 * CLI run from inside it. This names that file for the whole command, and
 * for everything the command starts in another directory (fleet-sync re-runs
 * itself from a checkout of the revision). `DEVFLEET_CONFIG` names a file
 * elsewhere and wins. Only the CLI does this: launchers and scheduled jobs
 * run in directories that belong to other projects and read the copy
 * fleet-sync installed.
 */
export function useProjectConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string | null {
  const named = env['DEVFLEET_CONFIG'];
  const path = named ? resolve(cwd, named) : projectConfig(cwd);
  if (path) env['DEVFLEET_CONFIG'] = path;
  return path;
}
