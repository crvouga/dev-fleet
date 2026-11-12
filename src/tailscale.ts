import { isIP } from 'node:net';
import { record } from './config';
import type { Check, Runner } from './types';

export interface TailnetComputer {
  id: string;
  name: string;
  dns: string;
  os: string;
  ips: string[];
  online: boolean;
  self: boolean;
  /** When the node key expires, in milliseconds since the epoch; absent when
   * it never does (tagged nodes, or expiry disabled in the admin console). */
  keyExpiry?: number;
}
export interface Tailnet {
  computers: TailnetComputer[];
  excludedMobile: number;
  checks: Check[];
}

export async function discoverTailnet(run: Runner): Promise<Tailnet> {
  const result = await run(['tailscale', 'status', '--json'], {
    timeoutMs: 15_000,
  });
  if (!result.ok)
    return unavailable(
      'Tailscale status is unavailable; check the CLI, daemon and account login.'
    );
  try {
    return parseTailnet(JSON.parse(result.stdout) as unknown);
  } catch {
    return unavailable(
      'Tailscale returned an unsupported status document. Update the CLI and check its daemon.'
    );
  }
}

export function parseTailnet(data: unknown): Tailnet {
  if (!record(data) || data['BackendState'] !== 'Running')
    return unavailable(
      'Tailscale is not running and signed in. Review tailscale status locally.'
    );
  validateStatusFields(data);
  const peers = Object.values(
    (data['Peer'] as Record<string, unknown> | null) ?? {}
  );
  if (peers.length > 1024) throw new Error('Too many peers');
  const all = [
    parseComputer(data['Self'], true),
    ...peers.map((peer) => parseComputer(peer, false)),
  ];
  if (new Set(all.map((peer) => peer.id)).size !== all.length)
    throw new Error('Duplicate peer');
  const mobile = (peer: TailnetComputer) =>
    ['ios', 'android', 'tvos'].includes(peer.os.toLowerCase());
  const computers = all
    .filter((peer) => !mobile(peer))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const healthy = healthyDiscovery(data, computers.length);
  return {
    computers,
    excludedMobile: all.filter(mobile).length,
    checks: [
      {
        id: 'tailscale:discovery',
        status: healthy ? 'pass' : 'fail',
        summary: healthy
          ? 'Signed-in Tailscale daemon returned its visible computer inventory.'
          : 'Tailscale reports a daemon/coordination health problem or no computers; discovery may be incomplete.',
        ...(!healthy
          ? {
              remedy: {
                action:
                  'Review tailscale status and network connectivity. Resolve coordination/daemon health before claiming complete coverage.',
              },
            }
          : {}),
      },
    ],
  };
}

function healthyDiscovery(
  data: Record<string, unknown>,
  count: number
): boolean {
  const health = (data['Health'] as unknown[] | null | undefined) ?? [];
  return health.length === 0 && count > 0;
}

function validateStatusFields(data: Record<string, unknown>): void {
  const health = data['Health'] ?? [];
  const peers = data['Peer'] ?? {};
  if (!record(data['Self']) || !record(peers) || !Array.isArray(health))
    throw new Error('Unsupported Tailscale status');
}

function parseComputer(value: unknown, self: boolean): TailnetComputer {
  if (!record(value)) throw new Error('Invalid peer');
  const {
    ID: id,
    HostName: name,
    DNSName: dns,
    OS: os,
    TailscaleIPs: ips,
    Online: online,
    KeyExpiry: keyExpiry,
  } = value;
  if (
    ![id, name, os].every(
      (field) =>
        typeof field === 'string' &&
        field.length > 0 &&
        field.length <= 256 &&
        !/[\x00-\x1f\x7f]/.test(field)
    ) ||
    typeof dns !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}\.?$/.test(dns) ||
    !Array.isArray(ips) ||
    ips.length < 1 ||
    ips.length > 16 ||
    !ips.every((ip) => typeof ip === 'string' && isIP(ip) !== 0) ||
    typeof online !== 'boolean'
  )
    throw new Error('Invalid peer fields');
  return {
    id: id as string,
    name: name as string,
    dns: dns.replace(/\.$/, '').toLowerCase(),
    os: os as string,
    ips: ips as string[],
    online,
    self,
    ...expiry(keyExpiry),
  };
}

function expiry(value: unknown): { keyExpiry?: number } {
  if (typeof value !== 'string') return {};
  const time = Date.parse(value);
  // Tailscale writes the zero time for a key that never expires.
  return Number.isFinite(time) && time > 0 ? { keyExpiry: time } : {};
}

const DAY_MS = 86_400_000;
const KEY_EXPIRY = { warnDays: 14, failDays: 3 };

/** A node drops off the tailnet on the day its key expires. The check warns
 * two weeks ahead and fails three days ahead, like a T3 link that expires.
 */
export function keyExpiryCheck(
  computer: TailnetComputer | undefined,
  now = Date.now()
): Check {
  const id = 'tailscale:key-expiry';
  if (!computer)
    return { id, status: 'skip', summary: 'TAILSCALE_KEY_EXPIRY_UNOBSERVED' };
  if (computer.keyExpiry === undefined)
    return {
      id,
      status: 'pass',
      summary: 'The Tailscale node key of this machine does not expire.',
    };
  const days = Math.floor((computer.keyExpiry - now) / DAY_MS);
  const remedy = {
    action: computer.self
      ? 'Renew the node key of the manager before it expires: tailscale up --force-reauth on the manager, or disable key expiry for it in the Tailscale admin console.'
      : 'Disable key expiry for the worker in the Tailscale admin console, or tag it (tagged nodes do not expire). With tailnet and the secret tailnet-admin declared, fleet-sync enrols workers tagged and disables expiry for an enrolled worker that still has one. After an expiry, re-join it as docs/operations.md describes (Tailscale key expiry).',
  };
  if (days < 0)
    return { id, status: 'fail', summary: 'TAILSCALE_KEY_EXPIRED', remedy };
  const summary = `TAILSCALE_KEY_EXPIRES_SOON in ${days} days`;
  if (days <= KEY_EXPIRY.failDays)
    return { id, status: 'fail', summary, remedy };
  if (days <= KEY_EXPIRY.warnDays)
    return { id, status: 'warn', summary, remedy };
  return {
    id,
    status: 'pass',
    summary: `The Tailscale node key expires in ${days} days.`,
  };
}

function unavailable(summary: string): Tailnet {
  return {
    computers: [],
    excludedMobile: 0,
    checks: [{ id: 'tailscale:discovery', status: 'fail', summary }],
  };
}
