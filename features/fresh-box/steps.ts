import { expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ubuntu from '../../ansible/ubuntu/policy.json';
import { loadDefinition } from '../../src/definition';
import { bootstrapRemote, prepareBootstrap } from '../../src/remote-bootstrap';
import { runCommand } from '../../src/runner';
import { sshArgs } from '../../src/ssh';
import type { Check, FleetNode, Runner } from '../../src/types';
import { World, steps, type DataTable } from '../support/gherkin';

const repo = resolve(import.meta.dir, '../..');
const image = 'dev-fleet-fresh-box';
const node: FleetNode = {
  id: 'fresh-box',
  ssh: 'fresh-box',
  workspace: '/unused',
  required: [],
};

async function must(command: string[], timeoutMs = 600_000): Promise<string> {
  const result = await runCommand(command, { cwd: repo, timeoutMs });
  if (!result.ok) throw new Error(`${command.slice(0, 3).join(' ')} failed`);
  return result.stdout.trim();
}

interface Bootstrap {
  checks: Check[];
  seconds: number;
  /** Whether the commit travelled with this run. */
  transferred: boolean;
}

/** One disposable machine for the whole feature: creating it and
 * bootstrapping it are too slow to repeat for every scenario, so both happen
 * once and every scenario reads what was observed.
 */
interface Box {
  container: string;
  scratch: string;
  revision: string;
  /** The commands found on the machine before anything was done to it. */
  present: string[];
  /** The production transport. Only the client configuration is the test's:
   * it holds what an operator's `~/.ssh/config` and `known_hosts` would.
   */
  transport: Runner;
  first?: Promise<Bootstrap>;
}
let box: Promise<Box> | undefined;

const BEFOREHAND = [
  'git',
  'curl',
  'python3',
  'ansible-playbook',
  'mise',
  'bun',
  'node',
];

async function sshClient(container: string, scratch: string): Promise<string> {
  const key = join(scratch, 'id_ed25519');
  await must(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  // "SSH is set up": the manager's key is authorized on the machine, and the
  // machine's host key was read out of band, here from the machine itself.
  const authorize =
    'install -d -m 700 -o fleettest -g fleettest /home/fleettest/.ssh && cat > /home/fleettest/.ssh/authorized_keys && chown fleettest:fleettest /home/fleettest/.ssh/authorized_keys && chmod 600 /home/fleettest/.ssh/authorized_keys';
  const authorized = await runCommand(
    ['docker', 'exec', '-i', container, 'sh', '-c', authorize],
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
  const knownHosts = join(scratch, 'known_hosts');
  await writeFile(
    knownHosts,
    `[127.0.0.1]:${port} ${hostKey.split(' ').slice(0, 2).join(' ')}\n`
  );
  const config = join(scratch, 'ssh_config');
  await writeFile(
    config,
    [
      `Host ${node.ssh}`,
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      '  User fleettest',
      `  IdentityFile ${key}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${knownHosts}`,
      '',
    ].join('\n')
  );
  return config;
}

async function createBox(): Promise<Box> {
  const scratch = await mkdtemp(join(tmpdir(), 'fleet-fresh-box-'));
  const container = `fleet-fresh-box-${process.pid}`;
  const revision = await must(['git', 'rev-parse', 'HEAD']);
  if (await must(['git', 'status', '--porcelain']))
    console.log('Note: uncommitted edits are not part of the tested commit.');
  await must([
    'docker',
    'build',
    '-q',
    '-t',
    image,
    '-f',
    'features/fresh-box/Dockerfile',
    'features/fresh-box',
  ]);
  await must([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    container,
    '-p',
    '127.0.0.1::22',
    image,
  ]);
  const config = await sshClient(container, scratch);
  const transport: Runner = (command, options) =>
    runCommand(
      command[0] === 'ssh'
        ? ['ssh', '-F', config, ...command.slice(1)]
        : command,
      options
    );
  // The SSH server needs a moment after the container starts.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await transport([...sshArgs(node), 'true'])).ok) break;
    await Bun.sleep(500);
  }
  const present: string[] = [];
  for (const command of BEFOREHAND)
    if ((await transport([...sshArgs(node), `command -v ${command}`])).ok)
      present.push(command);
  return { container, scratch, revision, present, transport };
}

export async function discardBox(): Promise<void> {
  if (!box) return;
  const created = await box.catch(() => null);
  if (!created) return;
  if (process.env['DEVFLEET_TEST_FRESH_BOX'] === 'keep')
    console.log(`Kept ${created.container} (docker exec -it … sh).`);
  else await runCommand(['docker', 'rm', '-f', created.container]);
  await rm(created.scratch, { recursive: true, force: true });
}

async function bootstrap(machine: Box): Promise<Bootstrap> {
  const payload = await prepareBootstrap(
    machine.scratch,
    machine.revision,
    runCommand,
    {
      checkout: repo,
      // The example fleet: the machine receives its configuration like any worker.
      definition: loadDefinition(resolve(repo, 'examples/fleet.json')),
    }
  );
  if (!payload) throw new Error('The commit under test could not be bundled.');
  let transferred = false;
  const observing: Runner = (command, options) => {
    if (command.at(-1)?.includes("'fleet-bootstrap'"))
      transferred = command.at(-1)!.endsWith("'transfer'");
    return machine.transport(command, options);
  };
  const started = Date.now();
  const report = await bootstrapRemote(node, payload, observing);
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\nBootstrap of the fresh machine (${seconds}s)`);
  for (const check of report.checks)
    console.log(`  ${check.status.padEnd(4)} ${check.id}  ${check.summary}`);
  return { checks: report.checks, seconds, transferred };
}

export class FreshBoxWorld extends World {
  machine!: Box;
  bootstrap!: Bootstrap;
  worktree = '';

  /** A command on the machine, over the same SSH transport fleet-sync uses. */
  async remote(command: string): Promise<{ ok: boolean; stdout: string }> {
    const result = await this.machine.transport([...sshArgs(node), command], {
      timeoutMs: 120_000,
    });
    return { ok: result.ok, stdout: result.stdout.trim() };
  }
  /** In the checkout of the commit under test, with the pinned tools. */
  pinned(
    tool: string,
    command: string
  ): Promise<{ ok: boolean; stdout: string }> {
    return this.remote(
      `cd "$HOME/.local/share/personal/fleet/revisions/${this.machine.revision}" && "$HOME/.local/bin/mise" exec --locked ${tool} -- ${command} 2>&1`
    );
  }
}

export const freshBox = steps<FreshBoxWorld>();
const { Given, When, Then } = freshBox;

Given(
  'a fresh Ubuntu {float} machine with an SSH server and an account that can use sudo',
  async (world, release: number) => {
    expect(release.toFixed(2)).toBe(ubuntu.release);
    box ??= createBox();
    world.machine = await box;
    expect(
      (await world.remote('. /etc/os-release && echo "$VERSION_ID"')).stdout
    ).toBe(ubuntu.release);
    expect((await world.remote('id -u')).stdout).not.toBe('0');
    expect((await world.remote('sudo -n true')).ok).toBe(true);
  }
);

Given(
  "the manager reaches it over SSH with its own key and the machine's verified host key",
  async (world) => {
    // The production options: batch mode, strict host keys, no agent.
    expect(sshArgs(node)).toContain('StrictHostKeyChecking=yes');
    expect((await world.remote('whoami')).stdout).toBe('fleettest');
  }
);

Then(
  'the machine had none of these commands when it was created:',
  (world, table: DataTable) => {
    expect(table.list().sort()).toEqual([...BEFOREHAND].sort());
    expect(world.machine.present).toEqual([]);
  }
);

const firstBootstrap = async (world: FreshBoxWorld): Promise<void> => {
  world.machine.first ??= bootstrap(world.machine);
  world.bootstrap = await world.machine.first;
};
When(
  'the manager bootstraps the machine at the commit under test',
  firstBootstrap
);
Given('the manager has bootstrapped the machine', firstBootstrap);

When('the manager bootstraps the machine again', async (world) => {
  world.bootstrap = await bootstrap(world.machine);
});

/** Reaching node convergence proves the machine needed nothing beforehand:
 * source transfer, operating system prerequisites, the locked toolchain and
 * frozen dependencies. A bootstrap that stops early reports a `bootstrap:` or
 * `ssh:` check instead of the node's own.
 */
Then('the bootstrap reaches node convergence', (world) => {
  const { checks } = world.bootstrap;
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.filter((check) => /^(bootstrap|ssh):/.test(check.id))).toEqual(
    []
  );
});

Then(
  'the machine holds the commit under test, checked out without its history',
  async (world) => {
    const checkout = `"$HOME/.local/share/personal/fleet/revisions/${world.machine.revision}"`;
    expect(
      (await world.remote(`git -C ${checkout} rev-parse HEAD`)).stdout
    ).toBe(world.machine.revision);
    expect(
      (await world.remote(`git -C ${checkout} rev-list --count HEAD`)).stdout
    ).toBe('1');
    expect((await world.remote(`test -d ${checkout}/node_modules`)).ok).toBe(
      true
    );
  }
);

Then(
  'the machine holds the fleet configuration, without the bucket it names',
  async (world) => {
    const installed = JSON.parse(
      (await world.remote('cat "$HOME/.config/dev-fleet/fleet.json"')).stdout
    ) as Record<string, unknown>;
    const example = JSON.parse(
      await readFile(resolve(repo, 'examples/fleet.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(example['state']).toBeDefined();
    expect(installed['state']).toBeUndefined();
    expect(installed['manager']).toEqual(example['manager']);
    expect(installed['workers']).toEqual(example['workers']);
  }
);

const miseToml = async (): Promise<{
  min_version: string;
  tools: Record<string, string | { version: string }>;
}> =>
  Bun.TOML.parse(await readFile(resolve(repo, 'mise.toml'), 'utf8')) as never;

Then('the machine runs the mise release mise.toml pins', async (world) => {
  const { min_version: pinned } = await miseToml();
  expect(
    (await world.remote('"$HOME/.local/bin/mise" --version')).stdout
  ).toStartWith(pinned);
});

Then('the devfleet launcher is installed on the machine', async (world) => {
  expect((await world.remote('test -x "$HOME/.local/bin/devfleet"')).ok).toBe(
    true
  );
});

Then(
  'these tools run on the machine at the version mise.toml pins:',
  async (world, table: DataTable) => {
    const { tools } = await miseToml();
    for (const { tool, command } of table.hashes()) {
      const pin = tools[tool!];
      const version = typeof pin === 'string' ? pin : pin!.version;
      expect(
        `${tool}: ${(await world.pinned(tool!, command!)).stdout}`
      ).toContain(version);
    }
  }
);

Then(
  'these packages are installed at the exact version the Ubuntu policy pins:',
  async (world, table: DataTable) => {
    const packages: Record<string, string> = ubuntu.packages;
    for (const name of table.list()) {
      const installed = await world.remote(
        `dpkg-query -W -f='\${Version}' ${name}`
      );
      expect(`${name}=${installed.stdout}`).toBe(`${name}=${packages[name]}`);
    }
  }
);

Then(
  'the machine reports these checks as passed:',
  (world, table: DataTable) => {
    const passed = world.bootstrap.checks
      .filter((check) => check.status === 'pass')
      .map((check) => check.id);
    for (const id of table.list()) expect(passed).toContain(id);
  }
);

When(
  'an agent creates a worktree with its own mise.toml on the machine',
  async (world) => {
    world.worktree = '$HOME/.t3/worktrees/fresh-box/check';
    const made = await world.remote(
      `w="${world.worktree}" && mkdir -p "$w" && printf '[env]\\nFRESH_BOX = "1"\\n' > "$w/mise.toml"`
    );
    expect(made.ok).toBe(true);
  }
);

Then(
  'the pinned tools resolve there without anyone trusting it',
  async (world) => {
    const resolved = await world.remote(
      `cd "${world.worktree}" && "$HOME/.local/bin/mise" which claude`
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.stdout).toContain('claude');
  }
);

Then('the commit was not sent again', (world) => {
  expect(world.bootstrap.transferred).toBe(false);
});

Then('it took less than {int} seconds', (world, seconds: number) => {
  expect(world.bootstrap.seconds).toBeLessThan(seconds);
});
