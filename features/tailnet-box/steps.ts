import { expect } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { FleetDefinition, MachineDefinition } from '../../src/definition';
import { runCommand } from '../../src/runner';
import { tailnetCleanup, tailnetLeftovers } from '../../src/tailnet-cleanup';
import {
  loginServer,
  parseTailnetConfig,
  tailnetControl,
  type ControlHttp,
  type TailnetConfig,
  type TailnetControl,
} from '../../src/tailnet-control';
import { matchComputers } from '../../src/tailnet-matching';
import { discoverTailnet, type TailnetComputer } from '../../src/tailscale';
import type { Check, CommandResult, FleetNode, Runner } from '../../src/types';
import { World, steps, type DataTable } from '../support/gherkin';
import lock from './support/lock.json';

const root = resolve(import.meta.dir, '../..');
const support = resolve(import.meta.dir, 'support');
const IMAGE = 'dev-fleet-tailnet-box';
const KEY_FILE = '/run/devfleet/tailnet-auth-key';

export class TailnetBoxWorld extends World {
  /** The control plane as fleet.json declares it. */
  config!: TailnetConfig;
  /** The same control plane, asked through the port published on this
   * machine: the machines reach it by its name on the private network.
   */
  api!: TailnetConfig;
  control!: TailnetControl;
  play?: { ok: boolean; output: string };
  tailnet: TailnetComputer[] = [];
  check?: Check;
  removed?: string;
  recreated?: string;
}

export const tailnetBox = steps<TailnetBoxWorld>();
const { Given, When, Then } = tailnetBox;

// ── The private network, built once for the whole feature ───────────────

interface Lab {
  id: string;
  scratch: string;
  network: string;
  headscale: string;
  /** The certificate authority the machines and this process trust. */
  ca: string;
  /** Headscale's API, through the port published on this machine. */
  api: string;
  /** A Headscale API key: the fleet's tailnet-admin for this run. */
  apiKey: string;
  /** The ID of the Headscale user the keys belong to. */
  user: string;
  machines: Map<string, Promise<string>>;
  joined: Map<string, Promise<void>>;
  /** The key each machine joined with. */
  keys: Map<string, string>;
}
let lab: Promise<Lab> | undefined;

async function must(
  command: string[],
  options: { input?: string; timeoutMs?: number } = {}
): Promise<string> {
  const result = await runCommand(command, {
    cwd: root,
    timeoutMs: options.timeoutMs ?? 600_000,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (!result.ok)
    throw new Error(
      `${command.slice(0, 4).join(' ')} failed: ${result.stderr.slice(-2000)}`
    );
  return result.stdout.trim();
}

/** A command on a machine, as root. */
const on = (
  container: string,
  command: string,
  options: { input?: string; timeoutMs?: number } = {}
): Promise<CommandResult> =>
  runCommand(
    [
      'docker',
      'exec',
      ...(options.input === undefined ? [] : ['-i']),
      container,
      'sh',
      '-c',
      command,
    ],
    {
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.input === undefined ? {} : { input: options.input }),
    }
  );

/** A certificate authority for this run and a certificate for Headscale's
 * name on the network and for the port published here.
 */
async function certificates(scratch: string): Promise<void> {
  const config = join(scratch, 'openssl.cnf');
  await Bun.write(
    config,
    [
      '[req]',
      'distinguished_name = dn',
      '[dn]',
      '[ca]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier = hash',
      '[server]',
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = DNS:headscale.fleet.test,IP:127.0.0.1',
      '',
    ].join('\n')
  );
  const at = (name: string) => join(scratch, name);
  await must([
    'openssl',
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-days',
    '2',
    '-subj',
    '/CN=fleet tailnet-box CA',
    '-config',
    config,
    '-extensions',
    'ca',
    '-keyout',
    at('ca.key'),
    '-out',
    at('ca.crt'),
  ]);
  await must([
    'openssl',
    'req',
    '-new',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-subj',
    '/CN=headscale.fleet.test',
    '-config',
    config,
    '-keyout',
    at('tls.key'),
    '-out',
    at('tls.csr'),
  ]);
  await must([
    'openssl',
    'x509',
    '-req',
    '-in',
    at('tls.csr'),
    '-CA',
    at('ca.crt'),
    '-CAkey',
    at('ca.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    config,
    '-extensions',
    'server',
    '-out',
    at('tls.crt'),
  ]);
}

/** Headscale's API, trusting only this run's certificate authority. */
function trusting(ca: string): ControlHttp {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: request.body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      tls: { ca },
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

async function ask(
  current: Pick<Lab, 'api' | 'apiKey' | 'ca'>,
  method: 'GET' | 'POST',
  path: string,
  body?: object
): Promise<Record<string, unknown>> {
  const response = await trusting(current.ca)({
    method,
    url: `${current.api}${path}`,
    headers: {
      authorization: `Bearer ${current.apiKey}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status !== 200)
    throw new Error(`Headscale answered ${response.status} to ${path}`);
  return response.body as Record<string, unknown>;
}

async function healthy(api: string, ca: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${api}/health`, {
        signal: AbortSignal.timeout(2000),
        tls: { ca },
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(500);
  }
  throw new Error('Headscale did not answer.');
}

async function createLab(): Promise<Lab> {
  const id = String(process.pid);
  const scratch = await mkdtemp(join(tmpdir(), 'fleet-tailnet-box-'));
  await certificates(scratch);
  const network = `fleet-tailnet-${id}`;
  const headscale = `fleet-headscale-${id}`;
  await must(['docker', 'network', 'create', network]);
  await must([
    'docker',
    'create',
    '--name',
    headscale,
    '--network',
    network,
    '--network-alias',
    'headscale.fleet.test',
    '--user',
    '0:0',
    '--tmpfs',
    '/var/lib/headscale',
    '-p',
    '127.0.0.1::8443',
    lock.headscale,
    'serve',
  ]);
  const etc = join(scratch, 'headscale');
  await mkdir(etc);
  await copyFile(join(support, 'headscale.yaml'), join(etc, 'config.yaml'));
  await copyFile(join(scratch, 'tls.crt'), join(etc, 'tls.crt'));
  await copyFile(join(scratch, 'tls.key'), join(etc, 'tls.key'));
  await must(['docker', 'cp', `${etc}/.`, `${headscale}:/etc/headscale`]);
  await must(['docker', 'start', headscale]);
  const published = await must(['docker', 'port', headscale, '8443/tcp']);
  const port = published.split('\n')[0]!.split(':').at(-1)!;
  const api = `https://127.0.0.1:${port}`;
  const ca = await readFile(join(scratch, 'ca.crt'), 'utf8');
  await healthy(api, ca);
  const apiKey = (
    await must([
      'docker',
      'exec',
      headscale,
      'headscale',
      'apikeys',
      'create',
      '--expiration',
      '3h',
    ])
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9._-]{20,}$/.test(line))
    .at(-1);
  if (!apiKey) throw new Error('Headscale printed no API key.');
  const created = await ask({ api, apiKey, ca }, 'POST', '/api/v1/user', {
    name: 'fleet',
  });
  const user = String((created['user'] as { id?: unknown } | undefined)?.id);
  // The disposable stand-in for a manager or a worker.
  await must([
    'docker',
    'build',
    '-q',
    '-t',
    IMAGE,
    '-f',
    join(support, 'Dockerfile'),
    support,
  ]);
  return {
    id,
    scratch,
    network,
    headscale,
    ca,
    api,
    apiKey,
    user,
    machines: new Map(),
    joined: new Map(),
    keys: new Map(),
  };
}

const container = (current: Lab, name: string): string =>
  `fleet-${name}-${current.id}`;

async function booted(name: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await on(name, 'systemctl is-system-running');
    if (['running', 'degraded'].includes(state.stdout.trim())) return;
    await Bun.sleep(500);
  }
  throw new Error('The machine did not boot.');
}

/** A disposable Ubuntu machine on the private network, booted with systemd,
 * trusting the run's certificate authority, with the Ubuntu playbooks as a
 * worker's checkout holds them.
 */
function machine(current: Lab, name: string): Promise<string> {
  let created = current.machines.get(name);
  if (!created) {
    created = (async () => {
      const box = container(current, name);
      // systemd as PID 1 needs the host's cgroups; tailscaled in the kernel
      // needs /dev/net/tun and NET_ADMIN, which a privileged container has.
      await must([
        'docker',
        'run',
        '-d',
        '--name',
        box,
        '--hostname',
        name,
        '--network',
        current.network,
        '--privileged',
        '--cgroupns=host',
        '-v',
        '/sys/fs/cgroup:/sys/fs/cgroup:rw',
        IMAGE,
      ]);
      await booted(box);
      await must([
        'docker',
        'cp',
        join(current.scratch, 'ca.crt'),
        `${box}:/usr/local/share/ca-certificates/fleet-tailnet-box.crt`,
      ]);
      expect((await on(box, 'update-ca-certificates')).ok).toBe(true);
      await must(['docker', 'cp', 'ansible/ubuntu/.', `${box}:/u`]);
      await must([
        'docker',
        'cp',
        join(support, 'firewall.yml'),
        `${box}:/u/tailnet-box-firewall.yml`,
      ]);
      return box;
    })();
    current.machines.set(name, created);
  }
  return created;
}

/** The production Tailscale play, with a key left where the seed or the
 * bootstrap leaves it.
 */
async function tailscalePlay(
  world: TailnetBoxWorld,
  box: string,
  hostname: string,
  key: string
): Promise<{ ok: boolean; output: string }> {
  const delivered = await on(
    box,
    `umask 077 && mkdir -p /run/devfleet && cat > ${KEY_FILE}`,
    { input: `${key}\n` }
  );
  expect(delivered.ok).toBe(true);
  const variables = await on(box, 'cat > /u/tailscale-vars.json', {
    input: JSON.stringify({
      tailnet_hostname: hostname,
      tailnet_login_server: loginServer(world.config) ?? '',
    }),
  });
  expect(variables.ok).toBe(true);
  const result = await on(
    box,
    'cd /u && ANSIBLE_NOCOLOR=1 ansible-playbook tailscale.yml --extra-vars @/u/tailscale-vars.json 2>&1',
    { timeoutMs: 900_000 }
  );
  return { ok: result.ok, output: result.stdout };
}

/** A key for the manager: its own user's, carrying no tag, so it is no
 * worker device.
 */
async function personalKey(current: Lab): Promise<string> {
  const answer = await ask(current, 'POST', '/api/v1/preauthkey', {
    user: current.user,
    reusable: false,
    ephemeral: false,
    expiration: new Date(Date.now() + 600_000).toISOString(),
  });
  const key = (answer['preAuthKey'] as { key?: unknown } | undefined)?.key;
  if (typeof key !== 'string') throw new Error('Headscale minted no key.');
  return key;
}

/** Joins `name` once for the feature: a worker with a key the control plane
 * mints for it, the manager with a key of its own user.
 */
function enrol(
  world: TailnetBoxWorld,
  name: string,
  personal = false
): Promise<void> {
  return lab!.then((current) => {
    let joined = current.joined.get(name);
    if (!joined) {
      joined = (async () => {
        const box = await machine(current, name);
        const key = personal
          ? await personalKey(current)
          : (await world.control.createAuthKey({ worker: name })).key;
        const play = await tailscalePlay(world, box, name, key);
        if (!play.ok)
          throw new Error(`${name} did not join:\n${play.output.slice(-3000)}`);
        current.keys.set(name, key);
      })();
      current.joined.set(name, joined);
    }
    return joined;
  });
}

async function status(name: string): Promise<Record<string, unknown>> {
  const current = await lab!;
  const result = await on(
    await machine(current, name),
    'tailscale status --json'
  );
  return result.ok
    ? (JSON.parse(result.stdout) as Record<string, unknown>)
    : { BackendState: 'Unavailable' };
}

const selfId = async (name: string): Promise<string> =>
  String(((await status(name))['Self'] as { ID?: unknown } | undefined)?.ID);

/** What the manager's curl got from a port of a worker: an HTTP status, or
 * 000 when nothing answered.
 */
async function fromManager(address: string, port: number): Promise<string> {
  const current = await lab!;
  const result = await on(
    await machine(current, 'manager'),
    `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${address}:${port}/ || true`
  );
  return result.stdout.trim();
}

async function privateAddress(name: string): Promise<string> {
  const current = await lab!;
  return must([
    'docker',
    'inspect',
    '-f',
    `{{(index .NetworkSettings.Networks "${current.network}").IPAddress}}`,
    await machine(current, name),
  ]);
}

export async function discardTailnetBox(): Promise<void> {
  if (!lab) return;
  const current = await lab.catch(() => null);
  if (!current) return;
  const boxes = await Promise.all(
    [...current.machines.values()].map((box) => box.catch(() => null))
  );
  for (const box of [...boxes, current.headscale])
    if (box)
      await runCommand(['docker', 'rm', '-f', box], { timeoutMs: 120_000 });
  await runCommand(['docker', 'network', 'rm', current.network]);
  await rm(current.scratch, { recursive: true, force: true });
}

// ── Steps ────────────────────────────────────────────────────────────────

Given(
  'a self-hosted Headscale at the version its lock pins, serving {string} on a private network',
  async (_world, origin: string) => {
    lab ??= createLab();
    const current = await lab;
    const config = parse(
      await readFile(join(support, 'headscale.yaml'), 'utf8')
    ) as { server_url: string };
    expect(config.server_url).toBe(origin);
    const [, digest] = lock.headscale.split('@');
    const running = await must([
      'docker',
      'image',
      'inspect',
      '-f',
      '{{json .RepoDigests}}',
      lock.headscale,
    ]);
    expect(running).toContain(digest!);
    expect(
      (
        await must([
          'docker',
          'inspect',
          '-f',
          '{{.State.Running}}',
          current.headscale,
        ])
      ).trim()
    ).toBe('true');
  }
);

Given(
  'the fleet declares the tailnet control plane:',
  async (world, declared: string) => {
    const current = await lab!;
    const config = parseTailnetConfig(JSON.parse(declared));
    expect(config).not.toBeNull();
    expect(config!.api === 'headscale' && config!.user).toBe(current.user);
    world.config = config!;
    world.api = { ...config!, url: current.api };
    world.control = tailnetControl(
      world.api,
      current.apiKey,
      trusting(current.ca)
    );
  }
);

Given(
  'a disposable Ubuntu machine {string} on that network',
  async (_world, name: string) => {
    const box = await machine(await lab!, name);
    expect(
      (await on(box, '. /etc/os-release && echo "$ID"')).stdout.trim()
    ).toBe('ubuntu');
  }
);

Given('{string} joined the tailnet', async (world, name: string) => {
  await enrol(world, name);
});

Given(
  '{string} joined the tailnet with a key of its own user, untagged',
  async (world, name: string) => {
    await enrol(world, name, true);
  }
);

When(
  'the Tailscale play runs on {string} with a key the control plane minted for {string}',
  async (world, name: string, worker: string) => {
    const current = await lab!;
    const box = await machine(current, name);
    const { key } = await world.control.createAuthKey({ worker });
    world.play = await tailscalePlay(world, box, name, key);
    if (world.play.ok) {
      current.keys.set(name, key);
      current.joined.set(name, Promise.resolve());
    }
  }
);

When(
  'the Tailscale play runs on {string} with the key {string} joined with',
  async (world, name: string, other: string) => {
    const current = await lab!;
    const key = current.keys.get(other);
    expect(key).toBeDefined();
    world.play = await tailscalePlay(
      world,
      await machine(current, name),
      name,
      key!
    );
  }
);

When('the manager reads the tailnet', async (world) => {
  const manager = await machine(await lab!, 'manager');
  const run: Runner = (command, options) =>
    runCommand(['docker', 'exec', manager, ...command], options);
  const tailnet = await discoverTailnet(run);
  expect(tailnet.checks.map((check) => check.status)).toEqual(['pass']);
  world.tailnet = tailnet.computers;
});

When(
  'the fleet firewall is applied on {string}',
  async (world, name: string) => {
    const box = await machine(await lab!, name);
    // sshd -T, which the firewall reads its ports from, needs this.
    await on(box, 'mkdir -p /run/sshd');
    const result = await on(
      box,
      'cd /u && ANSIBLE_NOCOLOR=1 ansible-playbook tailnet-box-firewall.yml 2>&1',
      { timeoutMs: 600_000 }
    );
    world.play = { ok: result.ok, output: result.stdout };
    if (!result.ok) throw new Error(result.stdout.slice(-3000));
  }
);

When(
  '{string} is destroyed, its device is removed through the tailnet clean-up, and a new machine joins as {string} with a new key',
  async (world, name: string, again: string) => {
    const current = await lab!;
    const old = await selfId(name);
    await must(['docker', 'rm', '-f', await machine(current, name)]);
    current.machines.delete(name);
    current.joined.delete(name);
    world.check = await tailnetCleanup(
      world.api,
      async (secret) => (secret === 'tailnet-admin' ? current.apiKey : null),
      trusting(current.ca)
    ).removeDevice({ id: name } as MachineDefinition, old);
    world.removed = old;
    world.recreated = again;
    await enrol(world, again);
  }
);

Then('{string} is signed in to the tailnet', async (_world, name: string) => {
  expect((await status(name))['BackendState']).toBe('Running');
});

Then(
  '{string} is not signed in to the tailnet',
  async (_world, name: string) => {
    expect((await status(name))['BackendState']).not.toBe('Running');
  }
);

const named = async (world: TailnetBoxWorld, name: string) =>
  (await world.control.listDevices(world.config.tag)).filter(
    (device) => device.name === name
  );

Then(
  'the control plane lists one device named {string}, tagged {string}',
  async (world, name: string, tag: string) => {
    const devices = await named(world, name);
    expect(devices.length).toBe(1);
    expect(devices[0]!.tags).toContain(tag);
  }
);

Then(
  'the control plane lists no device named {string}',
  async (world, name: string) => {
    expect(await named(world, name)).toEqual([]);
  }
);

Then(
  'the device {string} reports for itself is the one the control plane lists',
  async (world, name: string) => {
    expect((await named(world, name)).map((device) => device.id)).toEqual([
      await selfId(name),
    ]);
  }
);

Then(
  '{string} holds no enrolment key any more',
  async (_world, name: string) => {
    const box = await machine(await lab!, name);
    expect((await on(box, `test ! -e ${KEY_FILE}`)).ok).toBe(true);
  }
);

Then('the play stops at {string}', (world, task: string) => {
  expect(world.play?.ok).toBe(false);
  const failed = world
    .play!.output.split(/^TASK \[/m)
    .find((block) => block.startsWith(`${task}]`) && /^fatal: /m.test(block));
  expect(failed).toBeDefined();
});

Then(
  'these declared workers match these devices:',
  async (world, table: DataTable) => {
    const rows = table.hashes();
    const nodes: FleetNode[] = rows.map((row) => ({
      id: row['worker']!,
      ssh: row['worker']!,
      workspace: '',
      required: [],
    }));
    // OpenSSH resolves an alias it has no entry for to itself.
    const ssh: Runner = async (command) => ({
      ok: true,
      stdout: `hostname ${command.at(-1)}\n`,
      stderr: '',
      reason: 'exit',
    });
    const matches = await matchComputers(nodes, world.tailnet, ssh);
    const found = Object.fromEntries(
      nodes.map((node) => [
        node.id,
        world.tailnet
          .filter((peer) => matches.get(peer.id)?.includes(node))
          .map((peer) => peer.dns.split('.')[0]),
      ])
    );
    expect(found).toEqual(
      Object.fromEntries(rows.map((row) => [row['worker'], [row['device']]]))
    );
  }
);

Then(
  'the manager finds {string} by the device ID it reports for itself, at the tailnet name {string}',
  async (world, name: string, dns: string) => {
    const id = await selfId(name);
    expect(world.tailnet.find((peer) => peer.id === id)?.dns).toBe(dns);
  }
);

Then("the fleet's tailnet holds no leftover device", async (world) => {
  const definition = {
    tailnet: world.config,
    manager: { id: 'manager' },
    workers: [{ id: 'worker-one' }, { id: 'worker-two' }],
  } as unknown as FleetDefinition;
  expect(
    await tailnetLeftovers(definition, () => Promise.resolve(world.control))
  ).toEqual([]);
});

Given(
  '{string} serves HTTP on port {int} on every address, which the manager reaches over the private network',
  async (_world, name: string, port: number) => {
    const box = await machine(await lab!, name);
    await on(
      box,
      `systemctl is-active --quiet fleet-probe || systemd-run --unit=fleet-probe python3 -m http.server ${port} --bind 0.0.0.0 --directory /tmp`
    );
    const address = await privateAddress(name);
    let answer = '';
    for (let attempt = 0; attempt < 20 && answer !== '200'; attempt += 1) {
      answer = await fromManager(address, port);
      if (answer !== '200') await Bun.sleep(500);
    }
    expect(answer).toBe('200');
  }
);

Then(
  'the manager reaches port {int} of {string} over the tailnet',
  async (_world, port: number, name: string) => {
    const box = await machine(await lab!, name);
    const address = (await on(box, 'tailscale ip -4')).stdout.trim();
    expect(address).toMatch(/^100\./);
    // The first packets may wait for the path between the two to be set up.
    let answer = '';
    for (let attempt = 0; attempt < 10 && answer !== '200'; attempt += 1)
      answer = await fromManager(address, port);
    expect(answer).toBe('200');
  }
);

Then(
  'the manager does not reach port {int} of {string} over the private network',
  async (_world, port: number, name: string) => {
    expect(await fromManager(await privateAddress(name), port)).toBe('000');
  }
);

Then(
  'the clean-up reported {string} as {string}',
  (world, id: string, status: string) => {
    expect(world.check).toMatchObject({ id, status });
  }
);

Then('that device is not the one that was removed', async (world) => {
  const devices = await named(world, world.recreated!);
  expect(devices.map((device) => device.id)).not.toContain(world.removed);
});
