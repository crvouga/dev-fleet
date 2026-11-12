import { createConnection, isIP } from 'node:net';
import { record } from './config';
import { fleet } from './fleet-config';
import { workerExposure, type WorkerExposure } from './exposure';
import { MONITORING_AGENT_PORT } from './worker-exposure';
import type { Check, NodeReport, Runner } from './types';

/** Opens one TCP connection and closes it at once: whether it was accepted. */
export type Connect = (
  host: string,
  port: number,
  timeoutMs: number
) => Promise<boolean>;

export const tcpConnect: Connect = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

const UNRESTRICTED = 'WORKER_PUBLIC_PORT_UNRESTRICTED';

const PRIVATE_V4: [number, number][] = [
  [0x00000000, 8], // this network
  [0x0a000000, 8],
  [0x64400000, 10], // carrier-grade NAT and the tailnet
  [0x7f000000, 8],
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0xe0000000, 3], // multicast and reserved
];

/** An address the internet routes to: not private, loopback, link-local,
 * shared (which includes the tailnet), unique-local or multicast. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value =
      address
        .split('.')
        .reduce((total, part) => total * 256 + Number(part), 0) >>> 0;
    return !PRIVATE_V4.some(
      ([network, bits]) =>
        value >>> (32 - bits) === (network >>> (32 - bits)) >>> 0
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !(
      lower === '::' ||
      lower === '::1' ||
      /^fe[89ab]/.test(lower) ||
      /^f[cd]/.test(lower) ||
      /^ff/.test(lower)
    );
  }
  return false;
}

/** The public addresses Tailscale reaches a worker at (`Addrs` of its peer in
 * `tailscale status --json`), each once. */
export function publicEndpoints(
  status: unknown,
  tailscaleName: string
): string[] {
  if (!record(status) || !record(status['Peer'])) return [];
  const name = tailscaleName.toLowerCase();
  const peer = Object.values(status['Peer']).find(
    (entry) =>
      record(entry) &&
      typeof entry['DNSName'] === 'string' &&
      entry['DNSName'].replace(/\.$/, '').toLowerCase() === name
  );
  if (!record(peer) || !Array.isArray(peer['Addrs'])) return [];
  const found = new Set<string>();
  for (const entry of peer['Addrs'].slice(0, 32)) {
    if (typeof entry !== 'string') continue;
    const host = entry.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (isPublicAddress(host)) found.add(host);
  }
  return [...found];
}

/** worker:public-reachability, from the manager: none of the fleet's ports
 * accepts a connection on the worker's public address. Optional: the manager
 * may share the worker's network, so a failure here never blocks readiness;
 * worker:exposure is measured on the worker itself. Names the service and
 * port, never the address.
 */
export async function publicReachabilityCheck(
  rules: WorkerExposure,
  addresses: string[],
  connect: Connect = tcpConnect
): Promise<Check> {
  if (addresses.length === 0)
    return {
      id: 'worker:public-reachability',
      status: 'not-applicable',
      required: false,
      summary:
        'Tailscale knows no public address for this worker: there is nothing outside the tailnet to try.',
    };
  const ports = [
    ...(rules.policy.publicSsh ? [] : [{ name: 'SSH', port: rules.sshPort }]),
    { name: 'T3', port: rules.t3Port },
    { name: 'the monitoring agent', port: MONITORING_AGENT_PORT },
  ].filter(
    (entry) =>
      !rules.policy.publicPorts.some(
        (open) => open.protocol === 'tcp' && open.port === entry.port
      )
  );
  const accepted: string[] = [];
  for (const entry of ports)
    for (const address of addresses)
      if (await connect(address, entry.port, 3_000)) {
        accepted.push(`${entry.name} (tcp ${entry.port})`);
        break;
      }
  const tried = ports.map((entry) => `${entry.name} (tcp ${entry.port})`);
  if (accepted.length)
    return {
      id: 'worker:public-reachability',
      status: 'fail',
      required: false,
      summary: `${UNRESTRICTED} ${accepted.join(', ')} accepted a connection on the worker's public address.`,
      remedy: {
        action:
          'Run devfleet fleet-sync, which loads the fleet firewall on the worker, then read worker:exposure for the unit that listens. When the manager shares the worker’s network, confirm from a machine outside it before changing anything.',
      },
    };
  return {
    id: 'worker:public-reachability',
    status: 'pass',
    required: false,
    summary: `No connection was accepted on the worker's public address: ${tried.join(', ')}.`,
  };
}

/** Adds worker:public-reachability to the report of every declared worker
 * the tailnet knows. */
export async function appendPublicReachability(
  reports: NodeReport[],
  run: Runner,
  connect: Connect = tcpConnect
): Promise<void> {
  const status = await run(['tailscale', 'status', '--json'], {
    timeoutMs: 15_000,
  });
  let parsed: unknown = null;
  try {
    parsed = status.ok ? JSON.parse(status.stdout) : null;
  } catch {
    /* Raw status is never reported. */
  }
  for (const machine of fleet.workers) {
    const name = machine.network?.tailscaleName;
    const report = reports.find(
      (entry) => entry.node === name || entry.node === machine.id
    );
    if (!report || !name) continue;
    report.checks.push(
      parsed === null
        ? {
            id: 'worker:public-reachability',
            status: 'skip',
            required: false,
            summary:
              'Tailscale status is unavailable on the manager, so the public address of this worker is unknown.',
          }
        : await publicReachabilityCheck(
            workerExposure(fleet, machine.id),
            publicEndpoints(parsed, name),
            connect
          )
    );
  }
}
