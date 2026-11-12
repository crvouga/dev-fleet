import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FleetDefinition, MachineDefinition } from './definition';
import { stateRoot } from './state/paths';

/** How the manager reaches a worker, written once: every direct SSH session
 * (src/ssh.ts) and every Ansible run over SSH (fleet-validate's inventory,
 * with ansible/ansible.cfg) takes its options from here, so the two cannot
 * drift. Host keys are checked strictly and never learned on first use. A
 * few attempts and keepalives let a short network blip pass without ending
 * a long operation.
 */
export const SSH_TRANSPORT: readonly (readonly [string, string])[] = [
  ['BatchMode', 'yes'],
  ['StrictHostKeyChecking', 'yes'],
  ['UpdateHostKeys', 'no'],
  ['ConnectTimeout', '10'],
  ['ConnectionAttempts', '3'],
  ['ServerAliveInterval', '15'],
  ['ServerAliveCountMax', '4'],
];

/** A direct session also forwards nothing and shares no connection. Ansible
 * multiplexes its own (ControlPersist in ansible/ansible.cfg).
 */
export const SSH_SESSION: readonly (readonly [string, string])[] = [
  ['ClearAllForwardings', 'yes'],
  ['PermitLocalCommand', 'no'],
  ['ControlMaster', 'no'],
  ['ControlPath', 'none'],
];

/** The name a worker's host key is pinned under, whatever its address. */
export const hostKeyAlias = (id: string): string => `devfleet-${id}`;

/** The fleet-owned known_hosts file: a cache rendered from the pinned keys
 * (declared in a worker record, or in the fleet state). The operator's own
 * ~/.ssh files are neither read for it nor changed.
 */
export function knownHostsPath(env = process.env, home = homedir()): string {
  return join(dirname(stateRoot(env, home)), 'ssh', 'known_hosts');
}

/** A worker without an SSH alias is reached from its declared network
 * block: its tailnet name, user and port.
 */
export function declaredConnection(
  worker: MachineDefinition | undefined
):
  | (MachineDefinition & { network: NonNullable<MachineDefinition['network']> })
  | null {
  return worker && worker.ssh === undefined && worker.network
    ? (worker as MachineDefinition & {
        network: NonNullable<MachineDefinition['network']>;
      })
    : null;
}

/** Host keys pinned in the fleet state, by worker ID. Only the devfleet CLI
 * reads the state (it registers the reader); launchers and the worker probe
 * run under Node, which cannot open the state database.
 */
type PinReader = () => Record<string, string>;
let pinReader: PinReader | null = null;
export function readPinsWith(reader: PinReader | null): void {
  pinReader = reader;
}

/** The key each worker reached from declared data is pinned to: the one its
 * record or fleet.json declares, else the one the fleet state pins.
 */
export function pinnedKeys(
  definition: FleetDefinition,
  pins: Record<string, string> = pinReader?.() ?? {}
): Record<string, string> {
  return Object.fromEntries(
    definition.workers.flatMap((worker) => {
      const declared = declaredConnection(worker);
      const key = declared?.network.hostKey ?? pins[worker.id];
      return declared && key ? [[worker.id, key]] : [];
    })
  );
}

export function knownHostsText(keys: Record<string, string>): string {
  return [
    '# Managed by dev-fleet: rendered from the fleet state and worker records. Do not edit.',
    ...Object.entries(keys)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, key]) => `${hostKeyAlias(id)} ${key}`),
    '',
  ].join('\n');
}

/** Writes the fleet-owned known_hosts when it differs; returns its path. */
export function renderKnownHosts(
  definition: FleetDefinition,
  env = process.env,
  pins?: Record<string, string>
): string {
  const path = knownHostsPath(env);
  const text = knownHostsText(pinnedKeys(definition, pins));
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return path;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.new`, text, { mode: 0o600 });
  renameSync(`${path}.new`, path);
  return path;
}

const option = ([name, value]: readonly [string, string]): string =>
  `${name}=${value}`;

/** The options that reach one worker from declared data. */
export function connectionOptions(
  worker: MachineDefinition & {
    network: NonNullable<MachineDefinition['network']>;
  },
  knownHosts: string
): [string, string][] {
  return [
    ['HostKeyAlias', hostKeyAlias(worker.id)],
    ['UserKnownHostsFile', knownHosts],
    ['GlobalKnownHostsFile', '/dev/null'],
    ['User', worker.network.user],
    ['Port', String(worker.network.sshPort)],
  ];
}

/** `-o NAME=VALUE` for each option, as ssh takes them. */
export function sshOptionArgs(
  options: readonly (readonly [string, string])[]
): string[] {
  return options.flatMap((entry) => ['-o', option(entry)]);
}
