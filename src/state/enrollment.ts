import { existsSync } from 'node:fs';
import { FleetUsageError } from '../errors';
import {
  parseEnrollment,
  readEnrollment,
  type Enrollment,
} from '../machine/state';
import { adoptEarlier } from './legacy';
import { databasePath, stateRoot } from './paths';
import { readDocument, writeDocument } from './store';

/** The manager's approved and applied revision, from the fleet state. A
 * machine that has no state database yet reads the file that held it before
 * (`enrollment.json` in `earlier`); its first approval moves it.
 */
export async function loadEnrollment(
  earlier: string | null,
  env = process.env
): Promise<Enrollment | null> {
  const database = databasePath(stateRoot(env));
  if (earlier && !existsSync(database)) return readEnrollment(earlier);
  const stored = readDocument(database, 'enrollment');
  if (stored === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    value = null;
  }
  const enrollment = parseEnrollment(value);
  if (!enrollment)
    throw new FleetUsageError(
      'Invalid enrollment in the fleet state. Restore it from the bucket with devfleet fleet-state --restore; do not enroll a replacement using another machine’s identity.'
    );
  return enrollment;
}

export function storeEnrollment(state: Enrollment, env = process.env): void {
  adoptEarlier(env);
  writeDocument(
    databasePath(stateRoot(env)),
    'enrollment',
    JSON.stringify(state) + '\n'
  );
}
