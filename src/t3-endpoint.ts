import { discoverTailnet } from './tailscale';
import type { Check, FleetNode, Runner } from './types';

/** An origin no browser of the fleet uses: the private route must not let
 * a page served from it read the worker's T3.
 */
export const FOREIGN_ORIGIN = 'https://origin-check.invalid';

/** A fresh manager HTTPS request is transport evidence only. Never read
 * pairing material or treat HTTP health as an authenticated tool session.
 * A second request, from a foreign origin, must not be granted cross-origin
 * access.
 */
export async function verifyT3Endpoint(
  node: FleetNode,
  run: Runner,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch
): Promise<Check[]> {
  const tailnet = await discoverTailnet(run);
  const peer = tailnet.computers.find((entry) => entry.id === node.tailscaleId);
  if (!peer || !/^[a-z0-9.-]+\.ts\.net$/.test(peer.dns))
    return pending('T3_MANAGER_IDENTITY_UNVERIFIED');
  try {
    const response = await request('https://' + peer.dns, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (response.status !== 200) return pending('T3_MANAGER_ENDPOINT_REJECTED');
  } catch {
    return pending('T3_MANAGER_ENDPOINT_UNREACHABLE');
  }
  return [
    {
      id: 't3:manager-endpoint',
      status: 'pass',
      summary:
        'A fresh HTTPS request from the manager reached the enrolled private endpoint with valid TLS and HTTP 200. Pairing, server compatibility and tool execution remain unverified.',
    },
    await originCheck('https://' + peer.dns, request),
  ];
}

/** Grants cross-origin reads: it echoes the foreign origin, or allows any
 * origin together with credentials.
 */
function permissive(headers: Headers): boolean {
  const allowed = headers.get('access-control-allow-origin')?.trim();
  return (
    allowed === FOREIGN_ORIGIN ||
    (allowed === '*' &&
      headers.get('access-control-allow-credentials')?.trim() === 'true')
  );
}

async function originCheck(
  url: string,
  request: (url: string, options: RequestInit) => Promise<Response>
): Promise<Check> {
  const check = (status: Check['status'], summary: string): Check => ({
    id: 't3:manager-origin',
    status,
    summary,
    ...(status === 'pass'
      ? {}
      : {
          remedy: {
            action:
              'The private T3 route must not grant cross-origin access to pages from other sites. Restore the stock T3 server and its private Serve route from source; never add a proxy that rewrites CORS headers.',
          },
        }),
  });
  try {
    const response = await request(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Origin: FOREIGN_ORIGIN },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return permissive(response.headers)
      ? check('fail', 'T3_MANAGER_ORIGIN_UNRESTRICTED')
      : check(
          'pass',
          'A request from a foreign origin was not granted cross-origin access to the private T3 route.'
        );
  } catch {
    return check('warn', 'T3_MANAGER_ORIGIN_UNVERIFIED');
  }
}
function pending(code: string): Check[] {
  return [
    {
      id: 't3:manager-endpoint',
      status: 'fail',
      summary: code,
      remedy: {
        action:
          'Inspect the enrolled node’s private Serve route, T3 listener, Tailscale reachability and HTTPS capability. Restore the existing private route in source; never bypass TLS verification or interpret a local listener as manager access.',
      },
    },
  ];
}
