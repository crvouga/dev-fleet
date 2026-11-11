import { inspectRoute } from '../monitoring/hub';
import { parseTailnet } from '../tailscale';
import type { Check, Runner } from '../types';

/** The one place the route is declared; `t3-route.yml` receives it. */
export const T3_ROUTE = { port: '443', proxy: 'http://127.0.0.1:3773' };
const target = T3_ROUTE;
/** `t3-route.yml` publishes the route when port 443 has no owner; this refuses
 * a conflicting owner beforehand and measures the result. Stock Serve persists
 * independently of T3 startup, so a temporarily unavailable VPN does not
 * prevent the local development server from starting. No Funnel, pairing,
 * firewall change or service restart.
 */
export async function convergeT3Route(
  run: Runner,
  publish: () => Promise<boolean>
): Promise<Check[]> {
  const dns = await selfDns(run);
  if (!dns) return pending('T3_PRIVATE_IDENTITY_REQUIRED');
  const url = 'https://' + dns;
  const before = await run(['tailscale', 'serve', 'status', '--json']);
  if (!before.ok) return pending('T3_PRIVATE_ROUTE_UNVERIFIED');
  const route = inspectRoute(before.stdout, url, target);
  if (Array.isArray(route)) return pending('T3_PRIVATE_ROUTE_CONFLICT');
  if (!route && !(await publish())) return pending('T3_PRIVATE_ROUTE_REQUIRED');
  const after = route
    ? before
    : await run(['tailscale', 'serve', 'status', '--json']);
  if (!after.ok || inspectRoute(after.stdout, url, target) !== true)
    return pending('T3_PRIVATE_ROUTE_UNVERIFIED');
  return [
    {
      id: 't3:private-route',
      status: 'pass',
      summary:
        'Private HTTPS Serve route observed at ' +
        url +
        '; manager reachability and paired tool execution remain separate checks.',
    },
  ];
}
function pending(code: string): Check[] {
  return [
    {
      id: 't3:private-route',
      status: 'fail',
      summary: code,
      remedy: {
        action:
          'Inspect this node’s Tailscale identity, HTTPS capability and port 443 Serve ownership. Preserve existing routes; never reset Serve or enable Funnel. Pair using the native T3 client after a separate manager connection succeeds.',
      },
    },
  ];
}

async function selfDns(run: Runner): Promise<string | null> {
  const status = await run(['tailscale', 'status', '--json']);
  let dns: string | undefined;
  try {
    if (status.ok)
      dns = parseTailnet(JSON.parse(status.stdout)).computers.find(
        (peer) => peer.self
      )?.dns;
  } catch {
    /* No auth responses or raw status in reports. */
  }
  return dns && /^[a-z0-9.-]+\.ts\.net$/.test(dns) ? dns : null;
}
