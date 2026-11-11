import { discoverTailnet } from './tailscale';
import type { Check, FleetNode, Runner } from './types';

/** A fresh manager HTTPS request is transport evidence only. Never read
 * pairing material or treat HTTP health as an authenticated tool session.
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
    return [
      {
        id: 't3:manager-endpoint',
        status: 'pass',
        summary:
          'A fresh HTTPS request from the manager reached the enrolled private endpoint with valid TLS and HTTP 200. Pairing, server compatibility and tool execution remain unverified.',
      },
    ];
  } catch {
    return pending('T3_MANAGER_ENDPOINT_UNREACHABLE');
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
