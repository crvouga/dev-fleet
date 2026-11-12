import { record } from '../config';
import type { Check } from '../types';
import type { HubRequest } from './enroll';

/** The hub keeps one system per worker, named by its fleet ID. These change
 * that list when a worker is replaced or retired, and find the systems no
 * declared worker matches. Only names and hosts are read; a record's other
 * fields (tokens, users) are never returned.
 */
export interface HubSystem {
  id: string;
  name: string;
  host: string;
}

function systems(value: unknown): HubSystem[] {
  if (!record(value) || !Array.isArray(value['items']))
    throw new Error('BESZEL_PROTOCOL');
  return value['items'].flatMap((item) =>
    record(item) &&
    typeof item['id'] === 'string' &&
    /^[a-z0-9]{15}$/.test(item['id']) &&
    typeof item['name'] === 'string'
      ? [
          {
            id: item['id'],
            name: item['name'],
            host: typeof item['host'] === 'string' ? item['host'] : '',
          },
        ]
      : []
  );
}

export async function listSystems(request: HubRequest): Promise<HubSystem[]> {
  return systems(
    await request(
      '/api/collections/systems/records?perPage=500&fields=id,name,host'
    )
  );
}

async function named(request: HubRequest, node: string): Promise<HubSystem[]> {
  return systems(
    await request(
      `/api/collections/systems/records?filter=${encodeURIComponent(`name="${node}"`)}&perPage=2&fields=id,name,host`
    )
  );
}

const check = (status: Check['status'], summary: string, action?: string) => ({
  id: 'beszel:system',
  status,
  summary,
  ...(action ? { remedy: { action } } : {}),
});

/** Points a replaced worker's system at the host it is reached by now, so
 * the hub keeps one system for the ID and its history.
 */
export async function moveSystem(
  request: HubRequest,
  node: string,
  host: string
): Promise<Check> {
  const found = await named(request, node);
  if (found.length > 1)
    return check(
      'fail',
      'BESZEL_DUPLICATE_NODE',
      `The hub holds more than one system named ${node}. Delete the extra ones in the dashboard, then run the command again.`
    );
  if (!found[0])
    return check(
      'pass',
      `The hub holds no system for ${node}; fleet-sync enrolls the new machine.`
    );
  if (found[0].host === host)
    return check('pass', `The hub's system ${node} already watches ${host}.`);
  await request(
    `/api/collections/systems/records/${found[0].id}`,
    { host },
    'PATCH'
  );
  return check('pass', `The hub's system ${node} now watches ${host}.`);
}

/** Deletes a retired worker's system and its agent fingerprint. */
export async function removeSystem(
  request: HubRequest,
  node: string
): Promise<Check> {
  const found = await named(request, node);
  for (const system of found) {
    const prints = await request(
      `/api/collections/fingerprints/records?filter=${encodeURIComponent(`system="${system.id}"`)}&perPage=10&fields=id`
    );
    for (const print of record(prints) && Array.isArray(prints['items'])
      ? prints['items']
      : [])
      if (record(print) && typeof print['id'] === 'string')
        await request(
          `/api/collections/fingerprints/records/${print['id']}`,
          undefined,
          'DELETE'
        );
    await request(
      `/api/collections/systems/records/${system.id}`,
      undefined,
      'DELETE'
    );
  }
  return check(
    'pass',
    found.length
      ? `The hub no longer watches ${node}.`
      : `The hub holds no system for ${node}.`
  );
}

/** A system no declared worker (and not the manager) is named after: what a
 * worker removed by hand, or destroyed outside dev-fleet, leaves behind.
 */
export function leftoverSystems(
  found: HubSystem[],
  declared: string[]
): Check[] {
  return found
    .filter((system) => !declared.includes(system.name))
    .map((system) => ({
      id: 'beszel:leftover',
      status: 'warn' as const,
      summary: `The hub watches ${system.name}, which is no declared worker.`,
      remedy: {
        action: `If ${system.name} left the fleet, retire it (devfleet fleet-node-retire --id ${system.name} --apply --yes while it is still declared) or delete the system in the dashboard.`,
      },
    }));
}
