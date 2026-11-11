import { fleet } from '../fleet-config';
import lock from '../../ansible/monitoring/lock.json';
import type { Check } from '../types';

export interface BeszelEvidence {
  dashboardUrl: string;
  checks: Check[];
  receivedAt: string | null;
}
export type BeszelRequest = (path: string) => Promise<unknown>;
type Row = Record<string, unknown>;
function object(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function items(value: unknown): Row[] {
  if (
    !object(value) ||
    !Array.isArray(value['items']) ||
    !value['items'].every(object)
  )
    throw new Error('BESZEL_PROTOCOL');
  return value['items'];
}
function check(
  id: string,
  status: Check['status'],
  summary: string,
  action: string
): Check {
  return { id: `beszel:${id}`, status, summary, remedy: { action } };
}
/** Public dashboard hostname served through the Cloudflare
 * tunnel `beszel`. Agents and the manager keep using the private hub URL.
 */
export const publicHubUrl = (): string => fleet.services.monitoring.publicUrl;

export function privateHub(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.ts.net') ||
    url.port !== '8443' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('BESZEL_PRIVATE_URL');
  return url.origin;
}

/** Read-only PocketBase endpoints, verified against the upstream Beszel
 * release `ansible/monitoring/lock.json` pins.
 * Never return raw records: they may contain tokens, hosts or user information.
 */
export async function verifyBeszel(
  hub: string,
  node: string,
  request: BeszelRequest,
  now = Date.now()
): Promise<BeszelEvidence> {
  const dashboardUrl = privateHub(hub);
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(node)) throw new Error('BESZEL_NODE_ID');
  const result: BeszelEvidence = { dashboardUrl, checks: [], receivedAt: null };
  try {
    const info = await request('/api/beszel/info');
    if (!object(info) || info['v'] !== lock.version) {
      result.checks.push(
        check(
          'version',
          'fail',
          'BESZEL_VERSION_MISMATCH',
          'Apply the pinned hub release before using its versioned API contract.'
        )
      );
      return result;
    }
    result.checks.push(
      check(
        'version',
        'pass',
        `Authenticated hub reports ${lock.version}.`,
        'None.'
      )
    );
    const filter = encodeURIComponent(`name="${node}"`);
    const records = items(
      await request(
        `/api/collections/systems/records?filter=${filter}&perPage=2`
      )
    );
    if (records.length !== 1) {
      result.checks.push(
        check(
          'registration',
          'fail',
          records.length ? 'BESZEL_DUPLICATE_NODE' : 'BESZEL_NODE_MISSING',
          'Review the canonical node in the hub. Preserve its fingerprint and history; do not create a replacement identity.'
        )
      );
      return result;
    }
    await verifySample(records[0]!, result, request, now);
  } catch {
    result.checks.push(
      check(
        'api',
        'fail',
        'BESZEL_API_UNVERIFIED',
        'Verify private reachability and a valid hub account with access to this node. Raw HTTP bodies are withheld.'
      )
    );
  }
  return result;
}

/** No redirects, browser, token minting, retries or response logging. */
export function beszelReader(
  hub: string,
  token: string,
  fetcher: typeof fetch = fetch
): BeszelRequest {
  const origin = privateHub(hub);
  return async (path) => {
    if (!path.startsWith('/api/')) throw new Error('BESZEL_API_PATH');
    const response = await fetcher(`${origin}${path}`, {
      headers: { Authorization: token },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('BESZEL_API_UNVERIFIED');
    const text = await response.text();
    if (text.length > 256_000) throw new Error('BESZEL_RESPONSE_LIMIT');
    return JSON.parse(text) as unknown;
  };
}

async function verifySample(
  record: Row,
  result: BeszelEvidence,
  request: BeszelRequest,
  now: number
): Promise<void> {
  const id = record['id'];
  if (typeof id !== 'string' || !/^[a-z0-9]{15}$/.test(id))
    throw new Error('BESZEL_PROTOCOL');
  result.checks.push(
    check(
      'registration',
      'pass',
      'Exactly one canonical node record is visible to this account.',
      'None.'
    )
  );
  result.checks.push(
    check(
      'connection',
      record['status'] === 'up' ? 'pass' : 'fail',
      record['status'] === 'up'
        ? 'Hub reports node connected.'
        : 'BESZEL_AGENT_DISCONNECTED',
      'Inspect agent service, private hub connectivity and node-specific token; preserve its DATA_DIR.'
    )
  );
  await checkFreshness(id, result, request, now);
}
async function checkFreshness(
  id: string,
  result: BeszelEvidence,
  request: BeszelRequest,
  now: number
): Promise<void> {
  const stats = items(
    await request(
      `/api/collections/system_stats/records?filter=${encodeURIComponent(`system="${id}" && type="1m"`)}&sort=-created&perPage=1&fields=created`
    )
  );
  const created = stats[0]?.['created'];
  const timestamp = typeof created === 'string' ? Date.parse(created) : NaN;
  const fresh =
    Number.isFinite(timestamp) &&
    now - timestamp <= 180_000 &&
    now >= timestamp - 30_000;
  result.receivedAt = Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
  result.checks.push(
    check(
      'freshness',
      fresh ? 'pass' : 'fail',
      fresh
        ? `Hub received sample ${result.receivedAt}; within 180 seconds.`
        : 'BESZEL_METRICS_STALE',
      'Check hub and node clocks, agent connection and disk capacity. Rerun after the next sampling interval.'
    )
  );
}
