import { record } from '../config';
import type { Check, Runner } from '../types';
import { PUBLIC_HUB_URL } from './beszel';
import { secretVia } from '../fleet-config';

/** Shared Beszel hub helpers. The hub runs only on the manager; see
 * manager-hub.ts. Workers never host it.
 */
export function publicEndpointCheck(connected: boolean): Check {
  return connected
    ? {
        id: 'beszel:public-endpoint',
        status: 'pass',
        summary: `Cloudflare connector for ${PUBLIC_HUB_URL} was started from the Vault credential.`,
      }
    : {
        id: 'beszel:public-endpoint',
        status: 'warn',
        summary: 'BESZEL_TUNNEL_CREDENTIAL_UNAVAILABLE',
        remedy: {
          action: `Create the Cloudflare tunnel and store its token in the fleet's secrets, then log the manager's Vault session in with read access to secret/beszel/tunnel and rerun fleet-sync. The private dashboard is unaffected; ${PUBLIC_HUB_URL} stays offline until then.`,
        },
      };
}

/** The dashboard connector token from this fleet's secrets provider. Null
 * when it is unavailable. Never printed, logged or placed in argv.
 */
export function tunnelToken(run: Runner): Promise<string | null> {
  return secretVia(run)('monitoring-tunnel-token');
}
export function failure(code: string, action: string): Check[] {
  return [
    { id: 'beszel:hub', status: 'fail', summary: code, remedy: { action } },
  ];
}

export function inspectRoute(
  output: string,
  hub: string,
  target = { port: '8443', proxy: 'http://127.0.0.1:8090' }
): boolean | Check[] {
  let configured = false;
  try {
    const value: unknown = JSON.parse(output);
    if (!record(value)) throw new Error();
    if (publicOrConflictingTcp(value, hub, target.port))
      return failure(
        'BESZEL_PRIVATE_ROUTE_CONFLICT',
        'Existing Funnel/public or TCP routing conflicts with private Beszel access. Review the source-owned route; do not reset Serve.'
      );
    const web = value['Web'];
    if (record(web)) {
      const entry = web[new URL(hub).hostname + ':' + target.port];
      if (entry !== undefined) {
        if (!expectedHandler(entry, target.proxy))
          return failure(
            'BESZEL_PRIVATE_ROUTE_CONFLICT',
            'Port 8443 is owned by a different Tailscale Serve handler. Review a source-controlled route migration; do not reset Serve.'
          );
        configured = true;
      }
    }
  } catch {
    return failure(
      'BESZEL_PRIVATE_ROUTE_UNVERIFIED',
      'Review Tailscale Serve status without exposing raw configuration.'
    );
  }
  return configured;
}

function publicOrConflictingTcp(
  value: Record<string, unknown>,
  hub: string,
  port: string
): boolean {
  const funnel = value['AllowFunnel'];
  if (record(funnel) && funnel[new URL(hub).hostname + ':' + port] === true)
    return true;
  const tcp = value['TCP'];
  if (!record(tcp) || tcp[port] === undefined) return false;
  return !record(tcp[port]) || tcp[port]['HTTPS'] !== true;
}

function expectedHandler(entry: unknown, proxy: string): boolean {
  return (
    record(entry) &&
    record(entry['Handlers']) &&
    record(entry['Handlers']['/']) &&
    entry['Handlers']['/']['Proxy'] === proxy
  );
}
