import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDefinition } from '../../../src/definition';
import { UBUNTU_RELEASES } from '../../../src/platform/ubuntu-release';
import {
  bootstrapRemote,
  prepareBootstrap,
  type BootstrapPayload,
} from '../../../src/remote-bootstrap';
import { runCommand } from '../../../src/runner';
import { sshArgs } from '../../../src/ssh';
import type { Check, FleetNode, Runner } from '../../../src/types';

/** Disposable Ubuntu machines for the fresh-box features. Creating and
 * bootstrapping one is slow, so each is made once per run, by name, and every
 * scenario that names it shares it.
 */

export const repo = resolve(import.meta.dir, '../../..');

/** The Ubuntu release the machines run: DEVFLEET_TEST_FRESH_BOX_RELEASE, or
 * the newest the Ubuntu policy accepts. CI runs the features once for every
 * accepted release; the Dockerfile pins the image of each.
 */
export const RELEASE_UNDER_TEST =
  process.env['DEVFLEET_TEST_FRESH_BOX_RELEASE'] || UBUNTU_RELEASES[0]!.release;
const image = `dev-fleet-fresh-box:${RELEASE_UNDER_TEST}`;

/** The commands a machine must not have before the fleet bootstraps it. */
export const BEFOREHAND = [
  'git',
  'curl',
  'python3',
  'ansible-playbook',
  'mise',
  'bun',
  'node',
];

/** Where fleet-sync keeps its state on a worker. */
export const FLEET_ROOT = '/home/fleettest/.local/share/personal/fleet';

export async function must(
  command: string[],
  timeoutMs = 600_000
): Promise<string> {
  const result = await runCommand(command, { cwd: repo, timeoutMs });
  if (!result.ok) throw new Error(`${command.slice(0, 4).join(' ')} failed`);
  return result.stdout.trim();
}

export interface Bootstrap {
  checks: Check[];
  seconds: number;
  /** Whether the commit travelled with this run. */
  transferred: boolean;
}

export interface Box {
  name: string;
  container: string;
  node: FleetNode;
  /** The commands found on the machine before anything was done to it. */
  present: string[];
  /** The first bootstrap, shared by every scenario that needs one. */
  first?: Promise<Bootstrap>;
}

export interface BoxOptions {
  /** Mounts a small file system over the account's ~/.local. */
  smallHome?: boolean;
}

/** What an operator's ~/.ssh/config and known_hosts hold: one key for the
 * manager and one verified host key per machine. Shared by every machine.
 */
interface Client {
  scratch: string;
  key: string;
  config: string;
  knownHosts: string;
  revision: string;
}
let client: Promise<Client> | undefined;
const boxes = new Map<string, Promise<Box>>();
let built: Promise<void> | undefined;
let payload: Promise<BootstrapPayload> | undefined;
/** Machines are added to the shared client configuration one at a time. */
let adding: Promise<unknown> = Promise.resolve();

async function makeClient(): Promise<Client> {
  const scratch = await mkdtemp(join(tmpdir(), 'fleet-fresh-box-'));
  const key = join(scratch, 'id_ed25519');
  await must(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const config = join(scratch, 'ssh_config');
  const knownHosts = join(scratch, 'known_hosts');
  await writeFile(config, '');
  await writeFile(knownHosts, '');
  const revision = await must(['git', 'rev-parse', 'HEAD']);
  if (await must(['git', 'status', '--porcelain']))
    console.log('Note: uncommitted edits are not part of the tested commit.');
  return { scratch, key, config, knownHosts, revision };
}

export const sshClient = (): Promise<Client> => (client ??= makeClient());

/** The production transport. Only the client configuration is the test's. */
export const transport: Runner = async (command, options) => {
  const { config } = await sshClient();
  return runCommand(
    command[0] === 'ssh' ? ['ssh', '-F', config, ...command.slice(1)] : command,
    options
  );
};

/** The host key line the manager trusts for a machine. */
export function knownHostLine(port: string, hostKey: string): string {
  return `[127.0.0.1]:${port} ${hostKey.split(' ').slice(0, 2).join(' ')}\n`;
}

async function authorize(container: string, name: string): Promise<void> {
  const { key, config, knownHosts } = await sshClient();
  // "SSH is set up": the manager's key is authorized on the machine, and the
  // machine's host key was read out of band, here from the machine itself.
  const install =
    'install -d -m 700 -o fleettest -g fleettest /home/fleettest/.ssh && cat > /home/fleettest/.ssh/authorized_keys && chown fleettest:fleettest /home/fleettest/.ssh/authorized_keys && chmod 600 /home/fleettest/.ssh/authorized_keys';
  const authorized = await runCommand(
    ['docker', 'exec', '-i', container, 'sh', '-c', install],
    { input: await readFile(`${key}.pub`, 'utf8') }
  );
  if (!authorized.ok) throw new Error('The key could not be authorized.');
  const hostKey = await must([
    'docker',
    'exec',
    container,
    'cat',
    '/etc/ssh/ssh_host_ed25519_key.pub',
  ]);
  const port = (await must(['docker', 'port', container, '22/tcp']))
    .split('\n')[0]!
    .split(':')
    .at(-1)!;
  await appendFile(knownHosts, knownHostLine(port, hostKey));
  await appendFile(
    config,
    [
      `Host ${name}`,
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      '  User fleettest',
      `  IdentityFile ${key}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${knownHosts}`,
      '',
    ].join('\n')
  );
}

async function createBox(name: string, options: BoxOptions): Promise<Box> {
  built ??= must([
    'docker',
    'build',
    '-q',
    '--build-arg',
    `RELEASE=${RELEASE_UNDER_TEST}`,
    '-t',
    image,
    '-f',
    'features/fresh-box/Dockerfile',
    'features/fresh-box',
  ]).then(() => undefined);
  await built;
  const container = `fleet-${name}-${process.pid}`;
  await must([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    container,
    '-p',
    '127.0.0.1::22',
    ...(options.smallHome
      ? [
          '--mount',
          'type=tmpfs,destination=/home/fleettest/.local,tmpfs-size=67108864,tmpfs-mode=1777',
        ]
      : []),
    image,
  ]);
  const registered = adding.then(() => authorize(container, name));
  adding = registered.catch(() => undefined);
  await registered;
  const node: FleetNode = {
    id: name,
    ssh: name,
    workspace: '/unused',
    required: [],
    tailscaleId: name,
  };
  // The SSH server needs a moment after the container starts.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await transport([...sshArgs(node), 'true'])).ok) break;
    await Bun.sleep(500);
  }
  const present: string[] = [];
  for (const command of BEFOREHAND)
    if ((await transport([...sshArgs(node), `command -v ${command}`])).ok)
      present.push(command);
  return { name, container, node, present };
}

/** The machine of that name, created on first use. */
export function box(name: string, options: BoxOptions = {}): Promise<Box> {
  let created = boxes.get(name);
  if (!created) {
    created = createBox(name, options);
    boxes.set(name, created);
  }
  return created;
}

export async function discardBoxes(): Promise<void> {
  for (const created of boxes.values()) {
    const machine = await created.catch(() => null);
    if (!machine) continue;
    if (process.env['DEVFLEET_TEST_FRESH_BOX'] === 'keep')
      console.log(`Kept ${machine.container} (docker exec -it … sh).`);
    else await runCommand(['docker', 'rm', '-f', machine.container]);
  }
  if (client) {
    const { scratch } = await client;
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The commit under test, bundled once like fleet-sync bundles it, with the
 * example fleet as its configuration.
 */
export function bootstrapPayload(): Promise<BootstrapPayload> {
  payload ??= sshClient().then(async ({ scratch, revision }) => {
    const prepared = await prepareBootstrap(scratch, revision, runCommand, {
      checkout: repo,
      definition: loadDefinition(resolve(repo, 'examples/fleet.json')),
    });
    if (!prepared)
      throw new Error('The commit under test could not be bundled.');
    return prepared;
  });
  return payload;
}

/** One production bootstrap of a machine, over the given transport. */
export async function bootstrap(
  machine: Box,
  run: Runner = transport
): Promise<Bootstrap> {
  const prepared = await bootstrapPayload();
  // The Ansible task log covers this bootstrap only.
  await asRoot(machine, 'rm -f /tmp/fleet-ansible.log');
  let transferred = false;
  const observing: Runner = (command, options) => {
    if (command.at(-1)?.includes("'fleet-bootstrap'"))
      transferred = command.at(-1)!.endsWith("'transfer'");
    return run(command, options);
  };
  const started = Date.now();
  const report = await bootstrapRemote(machine.node, prepared, observing);
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\nBootstrap of ${machine.name} (${seconds}s)`);
  for (const check of report.checks)
    console.log(
      `  ${check.status.padEnd(4)} ${check.id}  ${check.summary}${
        // How long its phase took, so a slow run shows where the time went.
        (check.phaseDurationMs ?? 0) >= 1000
          ? `  [${Math.round(check.phaseDurationMs! / 1000)}s]`
          : ''
      }`
    );
  return { checks: report.checks, seconds, transferred };
}

/** The first bootstrap of a machine, run once and shared. */
export function firstBootstrap(machine: Box): Promise<Bootstrap> {
  machine.first ??= bootstrap(machine);
  return machine.first;
}

/** A command on the machine, over the same SSH transport fleet-sync uses. */
export async function remote(
  machine: Box,
  command: string,
  timeoutMs = 120_000
): Promise<{ ok: boolean; stdout: string }> {
  const result = await transport([...sshArgs(machine.node), command], {
    timeoutMs,
  });
  return { ok: result.ok, stdout: result.stdout.trim() };
}

/** A command on the machine outside the fleet's SSH session: as root, or
 * as the developer account.
 */
export async function asRoot(
  machine: Box,
  command: string,
  timeoutMs = 600_000,
  user = 'root'
): Promise<{ ok: boolean; stdout: string }> {
  const result = await runCommand(
    ['docker', 'exec', '-u', user, machine.container, 'sh', '-c', command],
    { timeoutMs }
  );
  return { ok: result.ok, stdout: result.stdout.trim() };
}

/** Starts a command on the machine as root and leaves it running. */
export async function startAsRoot(
  machine: Box,
  command: string,
  user = 'root'
): Promise<void> {
  await must([
    'docker',
    'exec',
    '-d',
    '-u',
    user,
    machine.container,
    'sh',
    '-c',
    command,
  ]);
}

/** Waits for a condition on the machine, checking every quarter second. */
export async function waitFor(
  machine: Box,
  command: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await asRoot(machine, command, 20_000)).ok) return true;
    await Bun.sleep(250);
  }
  return false;
}

/** Whether a fleet operation holds the machine's remote operation lock. */
export async function lockHeld(machine: Box): Promise<boolean> {
  return !(
    await asRoot(
      machine,
      `flock -n ${FLEET_ROOT}/remote-operation.lock true`,
      20_000,
      'fleettest'
    )
  ).ok;
}

/** Whether a check of node convergence came back: a bootstrap that stopped
 * early reports a `bootstrap:` or `ssh:` check instead of the node's own.
 */
export function reachedConvergence(checks: Check[]): boolean {
  return (
    checks.length > 0 &&
    !checks.some(
      (check) => /^(bootstrap|ssh):/.test(check.id) && check.status !== 'pass'
    )
  );
}
