import { isIP } from 'node:net';
import policy from '../ansible/ubuntu/policy.json';
import { record } from './config';
import type { PublicPort, WorkerExposure } from './exposure';
import type { Check, Runner, Status } from './types';

/** The beszel agent's port: it opens no listener (DISABLE_SSH), so one
 * listening on it is never the fleet's intention. */
export const MONITORING_AGENT_PORT = 45876;
/** The fleet's own services: a listener of theirs beyond loopback and the
 * tailnet always fails, whatever the policy says of other listeners. T3 is
 * the desktop app on a desktop worker and the server on a headless one. */
const FLEET_UNITS = [
  't3code-desktop.service',
  't3code-headless.service',
  'beszel-agent.service',
];
/** The table tasks/firewall.yml loads. */
export const FIREWALL_TABLE = ['inet', 'personal_fleet'];

export interface Listener {
  protocol: 'tcp' | 'udp';
  /** The bound address without its port: `0.0.0.0`, `::`, `127.0.0.1`. */
  address: string;
  /** The interface the socket is bound to (`%lo`), when it is. */
  device?: string;
  port: number;
  pids: number[];
}

/** `0.0.0.0:22`, `[::]:22`, `127.0.0.53%lo:53`, `*:68`: the address, the
 * interface it is bound to and the port. */
function localAddress(
  local: string
): { address: string; device?: string; port: number } | null {
  const colon = local.lastIndexOf(':');
  const port = Number(local.slice(colon + 1));
  if (colon < 1 || !Number.isInteger(port) || port < 1 || port > 65535)
    return null;
  const [bound = '', device] = local.slice(0, colon).split('%');
  const address = bound.replace(/^\[|\]$/g, '');
  return {
    address: address === '*' ? '0.0.0.0' : address,
    ...(device && /^[\w.@*-]{1,32}$/.test(device) ? { device } : {}),
    port,
  };
}

/** Listening TCP and UDP sockets from `ss -H -l -n -t -u -p`. */
export function parseListeners(text: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const protocol = fields[0];
    if (protocol !== 'tcp' && protocol !== 'udp') continue;
    const local = localAddress(fields[4] ?? '');
    if (!local) continue;
    const pids = [
      ...fields
        .slice(6)
        .join(' ')
        .matchAll(/pid=(\d+)/g),
    ].map((match) => Number(match[1]));
    listeners.push({ protocol, ...local, pids: [...new Set(pids)] });
  }
  return listeners;
}

interface Interface {
  name: string;
  addresses: { address: string; scope: string }[];
}

function parseInterfaces(text: string): Interface[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return null;
    return value.filter(record).map((entry) => ({
      name: typeof entry['ifname'] === 'string' ? entry['ifname'] : '',
      addresses: (Array.isArray(entry['addr_info']) ? entry['addr_info'] : [])
        .filter(record)
        .map((info) => ({
          address: typeof info['local'] === 'string' ? info['local'] : '',
          scope: typeof info['scope'] === 'string' ? info['scope'] : '',
        })),
    }));
  } catch {
    return null;
  }
}

/** `docker0`, `br-*`: an interface pattern of the policy, with `*` at its end. */
function matchesInterface(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*')
      ? name.startsWith(pattern.slice(0, -1))
      : name === pattern
  );
}

const exposure = policy.exposure;
const internal = (name: string) =>
  name === 'lo' ||
  name === exposure.tailnetInterface ||
  matchesInterface(name, exposure.containerInterfaces);

export function isLoopback(address: string): boolean {
  return (
    /^127\./.test(address) ||
    address === '::1' ||
    /^::ffff:127\./i.test(address)
  );
}

/** Tailscale's ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnet(address: string): boolean {
  const v4 = /^(?:::ffff:)?100\.(\d+)\./i.exec(address);
  if (v4) {
    const second = Number(v4[1]);
    return second >= 64 && second <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(address);
}

/** The addresses this worker has outside loopback, the tailnet and its
 * container bridges: where traffic from outside the tailnet arrives. */
export function outsideAddresses(interfaces: Interface[]): string[] {
  return interfaces
    .filter((entry) => !internal(entry.name))
    .flatMap((entry) => entry.addresses)
    .filter(
      (entry) =>
        entry.scope === 'global' &&
        isIP(entry.address) !== 0 &&
        !isTailnet(entry.address)
    )
    .map((entry) => entry.address);
}

/** The systemd unit a process runs in, read from its cgroup; never its
 * command line. */
export function unitOf(cgroup: string): string | null {
  const path = /^0::(\S+)$/m.exec(cgroup)?.[1] ?? '';
  const unit = path
    .split('/')
    .reverse()
    .find((part) => /\.(service|scope|socket)$/.test(part));
  if (!unit || !/^[\w@.:-]{1,128}$/.test(unit)) return null;
  return unit === 'init.scope' ? 'systemd' : unit;
}

interface Firewall {
  active: boolean;
  publicSsh: boolean;
}

/** What `nft -j list table inet personal_fleet` says of the rules. */
export function parseFirewall(text: string): Firewall {
  try {
    const value: unknown = JSON.parse(text);
    const items =
      record(value) && Array.isArray(value['nftables'])
        ? value['nftables'].filter(record)
        : [];
    const active = items.some(
      (item) =>
        record(item['chain']) &&
        item['chain']['hook'] === 'input' &&
        item['chain']['policy'] === 'drop'
    );
    const publicSsh = items.some(
      (item) => record(item['rule']) && item['rule']['comment'] === 'public-ssh'
    );
    return { active, publicSsh };
  } catch {
    return { active: false, publicSsh: false };
  }
}

const describe = (listener: Listener, unit: string | null): string => {
  const host = listener.address.includes(':')
    ? `[${listener.address}]`
    : listener.address;
  return `${listener.protocol} ${host}:${listener.port} (${unit ?? 'unknown unit'})`;
};

const allowed = (ports: PublicPort[], listener: Listener) =>
  ports.some(
    (entry) =>
      entry.protocol === listener.protocol && entry.port === listener.port
  );

/** The listeners the declared policy allows on every interface: sshd and
 * tailscaled (the firewall decides who reaches them), the system's own, and
 * the ports the policy opens. */
export function allowList(rules: WorkerExposure): PublicPort[] {
  return [
    { protocol: 'tcp', port: rules.sshPort },
    { protocol: 'udp', port: exposure.tailscalePort },
    ...(exposure.systemListeners as PublicPort[]),
    ...rules.policy.publicPorts,
  ];
}

const UNRESTRICTED = 'WORKER_LISTENER_UNRESTRICTED';

const REMEDY: Record<string, string> = {
  WORKER_FIREWALL_INACTIVE:
    'The fleet firewall is not loaded: run devfleet fleet-sync, which applies ansible/ubuntu/tasks/firewall.yml. Until then every listener below is reachable from every network the worker is on.',
  WORKER_PUBLIC_SSH_UNDECLARED:
    'SSH is still open beyond the tailnet because fleet-sync could not prove the manager reaches the worker over the tailnet. Point the SSH alias of this worker at its tailnet name, then run devfleet fleet-sync; declare exposure.publicSsh only for break-glass access.',
  WORKER_LISTENER_UNRESTRICTED:
    'Bind the named service to 127.0.0.1 or the tailnet address, or declare its port in exposure.publicPorts of fleet.json. A fleet service on a public address is a fault of its unit: run devfleet fleet-sync.',
  WORKER_EXPOSURE_UNOBSERVED:
    'The listening sockets or the firewall could not be read with sudo -n; check worker:sudo, then rerun devfleet fleet-status --workers.',
};

function result(status: Status, codes: string[], summary: string): Check {
  return {
    id: 'worker:exposure',
    status,
    summary,
    ...(status === 'pass' || status === 'not-applicable'
      ? {}
      : {
          remedy: {
            action: codes.map((code) => REMEDY[code]).join(' '),
          },
        }),
  };
}

/** What was read on the worker. */
interface Observed {
  interfaces: Interface[];
  listeners: Listener[];
  firewall: Firewall;
}

/** What the worker shows, or the check itself when exposure is not
 * applicable or could not be read. */
async function observe(run: Runner): Promise<Observed | Check> {
  const container = await run(['systemd-detect-virt', '--container']);
  if (container.ok)
    return result(
      'not-applicable',
      [],
      'This worker runs in a container: its network and firewall belong to its host.'
    );
  const addresses = await run(['ip', '-j', 'address', 'show']);
  const interfaces = addresses.ok ? parseInterfaces(addresses.stdout) : null;
  if (interfaces === null)
    return result(
      'fail',
      ['WORKER_EXPOSURE_UNOBSERVED'],
      'WORKER_EXPOSURE_UNOBSERVED (addresses)'
    );
  if (outsideAddresses(interfaces).length === 0)
    return result(
      'not-applicable',
      [],
      'This worker has no address outside the tailnet: nothing beyond it can connect.'
    );
  const sockets = await run([
    'sudo',
    '-n',
    'ss',
    '-H',
    '-l',
    '-n',
    '-t',
    '-u',
    '-p',
  ]);
  if (!sockets.ok)
    return result(
      'fail',
      ['WORKER_EXPOSURE_UNOBSERVED'],
      'WORKER_EXPOSURE_UNOBSERVED (sockets)'
    );
  const table = await run([
    'sudo',
    '-n',
    'nft',
    '-j',
    'list',
    'table',
    ...FIREWALL_TABLE,
  ]);
  return {
    interfaces,
    listeners: parseListeners(sockets.stdout),
    firewall: table.ok
      ? parseFirewall(table.stdout)
      : { active: false, publicSsh: false },
  };
}

/** The listeners beyond loopback, the tailnet and the container bridges. */
function exposedListeners(observed: Observed): Listener[] {
  const bridged = new Set(
    observed.interfaces
      .filter((entry) => internal(entry.name))
      .flatMap((entry) => entry.addresses.map((info) => info.address))
  );
  return observed.listeners.filter(
    (listener) =>
      !(listener.device && internal(listener.device)) &&
      !isLoopback(listener.address) &&
      !isTailnet(listener.address) &&
      !bridged.has(listener.address)
  );
}

/** The exposed listeners outside the allow-list, by who owns them: a fleet
 * service, or anything else. Each names its port and unit. */
async function unrestricted(
  rules: WorkerExposure,
  exposed: Listener[],
  run: Runner
): Promise<{ fleet: string[]; other: string[] }> {
  const units = new Map<number, string | null>();
  for (const pid of new Set(exposed.flatMap((listener) => listener.pids))) {
    const cgroup = await run(['cat', `/proc/${pid}/cgroup`]);
    units.set(pid, cgroup.ok ? unitOf(cgroup.stdout) : null);
  }
  const permitted = allowList(rules);
  const fleetPorts = [rules.t3Port, MONITORING_AGENT_PORT];
  const found = { fleet: new Set<string>(), other: new Set<string>() };
  for (const listener of exposed) {
    if (allowed(permitted, listener)) continue;
    const unit =
      listener.pids.map((pid) => units.get(pid)).find(Boolean) ?? null;
    const owned =
      fleetPorts.includes(listener.port) ||
      (unit !== null && FLEET_UNITS.includes(unit));
    (owned ? found.fleet : found.other).add(describe(listener, unit));
  }
  return { fleet: [...found.fleet], other: [...found.other] };
}

/** The firewall's own fault, when it has one. */
function firewallFault(rules: WorkerExposure, firewall: Firewall): string[] {
  if (!firewall.active) return ['WORKER_FIREWALL_INACTIVE'];
  if (firewall.publicSsh && !rules.policy.publicSsh)
    return ['WORKER_PUBLIC_SSH_UNDECLARED'];
  return [];
}

const listed = (listeners: string[]): string[] =>
  listeners.length ? [`${UNRESTRICTED} ${listeners.join(', ')}`] : [];

/** worker:exposure: nothing listens beyond loopback and the tailnet but what
 * the declared policy allows, and the firewall that closes the rest is
 * loaded. Not applicable without an address outside the tailnet. Reports a
 * port and the unit that owns it, never a process's arguments.
 */
export async function exposureCheck(
  rules: WorkerExposure,
  run: Runner
): Promise<Check> {
  const observed = await observe(run);
  if ('id' in observed) return observed;
  const { fleet, other } = await unrestricted(
    rules,
    exposedListeners(observed),
    run
  );
  const strict = rules.policy.otherListeners === 'fail';
  const failures = [
    ...firewallFault(rules, observed.firewall),
    ...listed(strict ? [...fleet, ...other] : fleet),
  ];
  const problems = [...failures, ...listed(strict ? [] : other)];
  if (problems.length)
    return result(
      failures.length ? 'fail' : 'warn',
      [...new Set(problems.map((problem) => problem.split(' ')[0]!))],
      problems.join('; ')
    );
  return result(
    'pass',
    [],
    rules.policy.publicSsh
      ? 'Only loopback, the tailnet and the declared allow-list listen beyond this worker, and the fleet firewall is loaded; SSH stays open beyond the tailnet by the declared break-glass opt-in.'
      : 'Only loopback, the tailnet and the declared allow-list listen beyond this worker, and the fleet firewall admits inbound traffic only over the tailnet.'
  );
}
