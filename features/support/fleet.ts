import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { reloadFleet } from '../../src/fleet-config';
import type { World } from './gherkin';

/** The example fleet.json, without the bucket it names. */
export function exampleFleet(): Record<string, unknown> {
  const { state: _bucket, ...example } = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../../examples/fleet.json'), 'utf8')
  ) as Record<string, unknown>;
  return example;
}

/** The workers of a fleet.json, to change in place. */
export const workersOf = (fleet: Record<string, unknown>) =>
  fleet['workers'] as Record<string, unknown>[];

/** Runs the rest of the scenario with the example fleet as `change` leaves
 * it, as every module that reads the fleet configuration sees it. The files
 * it writes beside fleet.json (worker records) go in `files`. The example
 * comes back afterwards.
 */
export function declareFleet(
  world: World,
  change: (fleet: Record<string, unknown>) => void,
  files: Record<string, string> = {}
): string {
  const directory = mkdtempSync(join(tmpdir(), 'devfleet-declared-'));
  const fleet = exampleFleet();
  change(fleet);
  const path = join(directory, 'fleet.json');
  writeFileSync(path, `${JSON.stringify(fleet, null, 2)}\n`);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(directory, name), text);
  const earlier = process.env['DEVFLEET_CONFIG'];
  process.env['DEVFLEET_CONFIG'] = path;
  reloadFleet();
  world.defer(() => {
    process.env['DEVFLEET_CONFIG'] = earlier;
    reloadFleet();
    rmSync(directory, { recursive: true, force: true });
  });
  return path;
}
