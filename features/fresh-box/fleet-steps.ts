import { expect } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import example from '../../examples/fleet.json';
import { packagePins, ubuntuRelease } from '../../src/platform/ubuntu-release';
import { parseDefinition } from '../../src/definition';
import { synchronizeManager, type ManagerReport } from '../../src/manager-sync';
import { PLATFORM_PROBE } from '../../src/machine/platform';
import type { CommandResult, Runner } from '../../src/types';
import type { DataTable } from '../support/gherkin';
import { freshBox, type FreshBoxWorld } from './steps';
import {
  FLEET_ROOT,
  RELEASE_UNDER_TEST,
  asRoot,
  bootstrap,
  box,
  firstBootstrap,
  knownHostLine,
  lockHeld,
  must,
  reachedConvergence,
  remote,
  sshClient,
  startAsRoot,
  transport,
  waitFor,
  type Bootstrap,
  type Box,
} from './support/boxes';

const { Given, When, Then } = freshBox;

/** What the fleet feature remembers between its steps. */
interface Fleet {
  machines: Box[];
  report?: ManagerReport;
  /** Something read on a machine before the run, to compare afterwards. */
  before?: string;
  /** A bootstrap started earlier in the scenario. */
  first?: Bootstrap;
  heldAfterDrop?: boolean;
}
const fleets = new WeakMap<FreshBoxWorld, Fleet>();
const fleet = (world: FreshBoxWorld): Fleet => {
  let state = fleets.get(world);
  if (!state) {
    state = { machines: [] };
    fleets.set(world, state);
  }
  return state;
};
const named = (world: FreshBoxWorld, name: string): Box => {
  const machine = fleet(world).machines.find((entry) => entry.name === name);
  if (!machine) throw new Error(`No machine "${name}" in this scenario.`);
  return machine;
};
const revisionDir = async (): Promise<string> =>
  `${FLEET_ROOT}/revisions/${(await sshClient()).revision}`;

Given(
  'these fresh machines of the Ubuntu release under test, each with only an SSH server and an account that can use sudo:',
  async (world, table: DataTable) => {
    expect(ubuntuRelease(RELEASE_UNDER_TEST)).toBeDefined();
    fleet(world).machines = await Promise.all(
      table.list().map((name) => box(name))
    );
  }
);

Given(
  'a fresh machine {string} of the Ubuntu release under test whose home has {int} MB free',
  async (world, name: string, megabytes: number) => {
    expect(ubuntuRelease(RELEASE_UNDER_TEST)).toBeDefined();
    expect(megabytes).toBe(64);
    const machine = await box(name, { smallHome: true });
    fleet(world).machines.push(machine);
    world.machine = machine;
  }
);

/** The machines are not on a tailnet: `tailscale status` and the SSH
 * aliases are answered as if each were online under its own name. They are
 * containers, which the platform probe refuses: its answer says "machine"
 * instead, and every other line of it is the machine's own.
 */
const tailnet: Runner = async (command, options) => {
  const names = command[0] === 'ssh' && command.includes('-G');
  if (names) return answer(`hostname ${command.at(-1)}.fleet.test\n`);
  const result = await transport(command, options);
  if (command[0] !== 'ssh' || command.at(-1) !== PLATFORM_PROBE) return result;
  return {
    ...result,
    stdout: result.stdout.replace(/^container$/m, 'machine'),
  };
};
let tailnetMachines: string[] = [];
const answer = (stdout: string): CommandResult => ({
  ok: true,
  stdout,
  stderr: '',
  reason: 'exit',
});
const peer = (name: string, address: number, self = false) => ({
  ID: name,
  HostName: name,
  DNSName: `${name}.fleet.test.`,
  OS: self ? 'macOS' : 'linux',
  TailscaleIPs: [`100.64.0.${address}`],
  Online: true,
});
const withTailnet: Runner = (command, options) =>
  command[0] === 'tailscale'
    ? Promise.resolve(
        answer(
          JSON.stringify({
            BackendState: 'Running',
            Self: peer('manager', 1, true),
            Peer: Object.fromEntries(
              tailnetMachines.map((name, index) => [
                name,
                peer(name, index + 2),
              ])
            ),
          })
        )
      )
    : tailnet(command, options);

Given('the tailnet shows each of them online under its own name', (world) => {
  tailnetMachines = fleet(world).machines.map((machine) => machine.name);
});

async function fleetRun(world: FreshBoxWorld, canary?: string): Promise<void> {
  const { machines } = fleet(world);
  const definition = parseDefinition({
    ...example,
    workers: machines.map((machine) => ({
      id: machine.name,
      ssh: machine.name,
      os: 'linux',
    })),
  });
  fleet(world).report = await synchronizeManager(
    {
      definition,
      nodes: machines.map((machine) => machine.node),
      revision: (await sshClient()).revision,
      apply: true,
      ...(canary ? { canary } : {}),
    },
    withTailnet,
    async (node) => ({
      node: node.id,
      checks: (await bootstrap(named(world, node.id), withTailnet)).checks,
    })
  );
}

When(
  'fleet-sync applies the commit under test to every machine in one run',
  (world) => fleetRun(world)
);

When(
  'fleet-sync applies the commit under test with {string} as its canary',
  (world, canary: string) => fleetRun(world, canary)
);

const report = (world: FreshBoxWorld): ManagerReport => {
  const run = fleet(world).report;
  if (!run) throw new Error('No run of fleet-sync in this scenario.');
  return run;
};
const nodeReport = (world: FreshBoxWorld, name: string) => {
  const node = report(world).nodes.find((entry) => entry.node === name);
  if (!node) throw new Error(`The report has no "${name}".`);
  return node;
};

Then(
  'the report is version {int} and covers, in order:',
  (world, version: number, table: DataTable) => {
    expect(report(world).version).toBe(version as 3);
    expect(report(world).nodes.map((node) => node.node)).toEqual(table.list());
  }
);

Then('every machine reached node convergence', (world) => {
  for (const node of report(world).nodes)
    expect(`${node.node}: ${reachedConvergence(node.checks)}`).toBe(
      `${node.node}: true`
    );
});

Then('every machine holds the commit under test', async (world) => {
  const { revision } = await sshClient();
  for (const machine of fleet(world).machines)
    expect(
      (await remote(machine, `git -C ${await revisionDir()} rev-parse HEAD`))
        .stdout
    ).toBe(revision);
});

Then('no machine is recorded as having the revision applied', (world) => {
  expect(report(world).ok).toBe(false);
  for (const node of report(world).nodes)
    expect(node.appliedRevision).toBeNull();
});

Then(
  'no machine has a schedule of its own that runs fleet-sync',
  async (world) => {
    // Workers never pull: only the manager schedules fleet-sync.
    for (const machine of fleet(world).machines) {
      const found = await asRoot(
        machine,
        // A unit that runs it, a timer for such a unit, or a cron line.
        "grep -rlsE '^ExecStart=.*fleet-sync' /etc/systemd /home/fleettest/.config/systemd; ls /etc/systemd/system/*fleet-sync*.timer /home/fleettest/.config/systemd/user/*fleet-sync*.timer 2>/dev/null; grep -rls fleet-sync /etc/cron.d /etc/crontab /var/spool/cron 2>/dev/null; true"
      );
      expect(`${machine.name}: ${found.stdout}`).toBe(`${machine.name}: `);
    }
  }
);

Given('every machine has been bootstrapped', async (world) => {
  const runs = await Promise.all(fleet(world).machines.map(firstBootstrap));
  for (const run of runs) expect(reachedConvergence(run.checks)).toBe(true);
});

/** Another fleet operation: a process holding the remote operation lock. */
Given('another fleet operation holds {string}', async (world, name: string) => {
  const machine = named(world, name);
  await startAsRoot(
    machine,
    `exec flock ${FLEET_ROOT}/remote-operation.lock sleep 900`,
    'fleettest'
  );
  world.defer(async () => {
    await asRoot(machine, "pkill -f 'remote-operation[.]lock sleep 900'");
  });
  expect(await waitFor(machine, 'true', 1_000)).toBe(true);
  const deadline = Date.now() + 20_000;
  while (!(await lockHeld(machine)) && Date.now() < deadline)
    await Bun.sleep(250);
  expect(await lockHeld(machine)).toBe(true);
  fleet(world).before = (
    await asRoot(
      named(world, 'fleet-b'),
      `cat ${FLEET_ROOT}/remote-operation.json`
    )
  ).stdout;
});

Then(
  '{string} reports {string} with a remedy',
  (world, name: string, code: string) => {
    const check = nodeReport(world, name).checks.find(
      (entry) => entry.summary === code
    );
    expect(check?.remedy?.action ?? '').not.toBe('');
  }
);

Then(
  'the checks of {string} include a passing {string}',
  (world, name: string, id: string) => {
    expect(
      nodeReport(world, name).checks.some(
        (check) => check.id === id && check.status === 'pass'
      )
    ).toBe(true);
  }
);

Then(
  'the last check of {string} says {string}',
  (world, name: string, summary: string) => {
    expect(nodeReport(world, name).checks.at(-1)?.summary).toBe(summary);
  }
);

Then('no fleet operation ran on {string}', async (world, name: string) => {
  const machine = named(world, name);
  expect(
    nodeReport(world, name).checks.some((check) =>
      check.id.startsWith('bootstrap:')
    )
  ).toBe(false);
  // Every operation records its own process in this file.
  expect(
    (await asRoot(machine, `cat ${FLEET_ROOT}/remote-operation.json`)).stdout
  ).toBe(fleet(world).before ?? '');
});

When(
  'a second bootstrap of {string} starts while a first one holds it',
  async (world, name: string) => {
    const machine = named(world, name);
    world.machine = machine;
    const first = bootstrap(machine);
    const deadline = Date.now() + 60_000;
    while (!(await lockHeld(machine)) && Date.now() < deadline)
      await Bun.sleep(100);
    world.bootstrap = await bootstrap(machine);
    fleet(world).first = await first;
  }
);

Then(
  'the second bootstrap followed the first and reports its node convergence',
  (world) => {
    expect(
      world.bootstrap.checks.some((check) => check.id === 'bootstrap:attached')
    ).toBe(true);
    expect(reachedConvergence(world.bootstrap.checks)).toBe(true);
  }
);

When(
  "the manager's SSH connection to {string} drops for {int} seconds while APT runs there",
  async (world, name: string, seconds: number) => {
    const machine = named(world, name);
    world.machine = machine;
    const { config } = await sshClient();
    let dropped = false;
    const dropping: Runner = async (command, options) => {
      if (dropped || !command.at(-1)?.includes("'fleet-bootstrap'"))
        return transport(command, options);
      dropped = true;
      const child = Bun.spawn(['ssh', '-F', config, ...command.slice(1)], {
        stdin: new Blob([String(options?.input ?? '')]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await waitFor(machine, 'pgrep -x apt-get', 300_000)).toBe(true);
      child.kill(9);
      await child.exited;
      // The link stays down; nothing reaches the worker until it is back.
      await Bun.sleep(seconds * 1000);
      return {
        ok: false,
        stdout: '',
        stderr: `Connection to ${name} closed by remote host.\n`,
        reason: 'exit',
      };
    };
    world.bootstrap = await bootstrap(machine, dropping);
  }
);

Then(
  'the bootstrap followed the operation and reached node convergence',
  (world) => {
    expect(
      world.bootstrap.checks.some((check) => check.id === 'bootstrap:attached')
    ).toBe(true);
    expect(reachedConvergence(world.bootstrap.checks)).toBe(true);
  }
);

Then('the first bootstrap reaches node convergence', (world) => {
  expect(reachedConvergence(fleet(world).first?.checks ?? [])).toBe(true);
});

Given(
  '{string} lacks the bootstrap package {string}',
  async (world, name: string, pkg: string) => {
    const machine = named(world, name);
    world.machine = machine;
    // Its downloaded archive too, so installing it again needs the network.
    const removed = await asRoot(
      machine,
      `DEBIAN_FRONTEND=noninteractive apt-get remove -y --allow-change-held-packages ${pkg} >/dev/null 2>&1; apt-get clean; ! dpkg-query -W -f='\${db:Status-Status}' ${pkg} 2>/dev/null | grep -qx installed`
    );
    expect(removed.ok).toBe(true);
  }
);

When(
  "the manager's SSH connection to {string} drops while APT runs there",
  async (world, name: string) => {
    const machine = named(world, name);
    world.machine = machine;
    const { config } = await sshClient();
    const dropping: Runner = async (command, options) => {
      if (!command.at(-1)?.includes("'fleet-bootstrap'"))
        return transport(command, options);
      const child = Bun.spawn(['ssh', '-F', config, ...command.slice(1)], {
        stdin: new Blob([String(options?.input ?? '')]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const running = await waitFor(machine, 'pgrep -x apt-get', 300_000);
      child.kill(9);
      await child.exited;
      fleet(world).heldAfterDrop = running && (await lockHeld(machine));
      return { ok: false, stdout: '', stderr: '', reason: 'exit' };
    };
    fleet(world).first = await bootstrap(machine, dropping);
  }
);

Then(
  'the remote operation lock of {string} was still held after the connection dropped',
  (world) => {
    expect(fleet(world).heldAfterDrop).toBe(true);
  }
);

Then(
  'once that operation has ended, the next bootstrap of {string} reaches node convergence',
  async (world, name: string) => {
    const machine = named(world, name);
    const deadline = Date.now() + 900_000;
    while ((await lockHeld(machine)) && Date.now() < deadline)
      await Bun.sleep(1_000);
    world.bootstrap = await bootstrap(machine);
    expect(reachedConvergence(world.bootstrap.checks)).toBe(true);
  }
);

Then(
  /^the package "([^"]+)" is (installed|not installed) on "([^"]+)"$/,
  async (world, pkg: string, state: string, name: string) => {
    const status = await asRoot(
      named(world, name),
      `dpkg-query -W -f='\${db:Status-Status}' ${pkg} 2>/dev/null; true`
    );
    expect(status.stdout === 'installed').toBe(state === 'installed');
  }
);

Given(
  /^"([^"]+)" holds the checkout of the commit under test as an interrupted checkout left it: no commit, and "([^"]+)" (half written|written by someone)$/,
  async (world, name: string, file: string) => {
    const machine = named(world, name);
    world.machine = machine;
    const directory = await revisionDir();
    // Removed afterwards whatever happened: the next run transfers it anew.
    world.defer(async () => {
      await asRoot(machine, `rm -rf ${directory}`);
    });
    const made = await asRoot(
      machine,
      `rm -rf ${directory} && mkdir -p ${directory} && git -C ${directory} init -q && printf 'partial' > ${directory}/${file}`,
      60_000,
      'fleettest'
    );
    expect(made.ok).toBe(true);
  }
);

When('the manager bootstraps {string}', async (world, name: string) => {
  world.machine = named(world, name);
  world.bootstrap = await bootstrap(world.machine);
});

Then(
  '{string} holds the commit under test with no uncommitted change',
  async (world, name: string) => {
    const machine = named(world, name);
    const directory = await revisionDir();
    expect(
      (await remote(machine, `git -C ${directory} rev-parse HEAD`)).stdout
    ).toBe((await sshClient()).revision);
    const status = await remote(
      machine,
      `git -C ${directory} status --porcelain`
    );
    expect(status.ok).toBe(true);
    expect(status.stdout).toBe('');
  }
);

Then(
  /^the bootstrap reports "([^"]+)" with a remedy(?: that says "([^"]+)")?$/,
  (world, code: string, says: string | undefined) => {
    const check = world.bootstrap.checks.find(
      (entry) => entry.summary === code
    );
    expect(check?.summary).toBe(code);
    expect(check?.remedy?.action ?? '').not.toBe('');
    if (says) expect(check?.remedy?.action).toContain(says);
  }
);

Then(
  '{string} is still in that checkout on {string}',
  async (world, file: string, name: string) => {
    expect(
      (
        await remote(
          named(world, name),
          `test -f ${await revisionDir()}/${file}`
        )
      ).ok
    ).toBe(true);
  }
);

Given(
  /^a package installation (fleet-sync|someone else) started on "([^"]+)" was interrupted after unpacking "([^"]+)"$/,
  async (world, starter: string, name: string, pkg: string) => {
    const machine = named(world, name);
    world.defer(async () => {
      await asRoot(machine, 'dpkg --configure -a >/dev/null 2>&1; true');
    });
    const downloaded = await asRoot(
      machine,
      `cd /tmp && rm -f ${pkg}_*.deb && apt-get download ${pkg} >/dev/null 2>&1`,
      300_000,
      'fleettest'
    );
    expect(downloaded.ok).toBe(true);
    const unpacked = await asRoot(
      machine,
      `dpkg --unpack /tmp/${pkg}_*.deb >/dev/null 2>&1 && test -n "$(dpkg --audit)"`
    );
    expect(unpacked.ok).toBe(true);
    // What the bootstrap leaves while its own installation is under way.
    const marker = `${FLEET_ROOT}/prerequisites-pending`;
    await asRoot(
      machine,
      starter === 'fleet-sync' ? `touch ${marker}` : `rm -f ${marker}`,
      20_000,
      'fleettest'
    );
  }
);

Given(
  '{string} must set its toolchain up again',
  async (world, name: string) => {
    const machine = named(world, name);
    expect(
      (
        await asRoot(
          machine,
          `rm -f ${FLEET_ROOT}/toolchain-ready`,
          20_000,
          'fleettest'
        )
      ).ok
    ).toBe(true);
  }
);

When(
  'every process of the toolchain setup on {string} is killed while it runs',
  async (world, name: string) => {
    const machine = named(world, name);
    world.machine = machine;
    // The setup lasts seconds, so the machine itself watches for it, every
    // 50 ms, and stops every process of the operation at once, as when the
    // machine loses power: the setup's whole process group and each process
    // holding the operation lock. The anchor keeps the pattern from matching
    // the bootstrap script, whose own command line holds this text.
    const killer = asRoot(
      machine,
      [
        'i=0',
        'until pid=$(pgrep -f \'^bash bootstrap/[b]ootstrap.sh --worker\' | head -1) && [ -n "$pid" ]; do i=$((i + 1)); [ $i -lt 6000 ] || exit 1; sleep 0.05; done',
        'group=$(ps -o pgid= -p "$pid" | tr -d \' \')',
        'pkill -KILL -g "$group"',
        'for p in /proc/[0-9]*; do ls -l "$p/fd" 2>/dev/null | grep -q \'remote-operation[.]lock\' && kill -KILL "${p#/proc/}"; done',
        'true',
      ].join('\n'),
      400_000,
      // Only the account's own processes show their open files to it.
      'fleettest'
    );
    const interrupted = bootstrap(machine);
    expect((await killer).ok).toBe(true);
    world.bootstrap = await interrupted;
  }
);

Then('the interrupted bootstrap did not reach node convergence', (world) => {
  expect(reachedConvergence(world.bootstrap.checks)).toBe(false);
});

Then(
  'the next bootstrap of {string} reaches node convergence',
  async (world, name: string) => {
    world.bootstrap = await bootstrap(named(world, name));
    expect(reachedConvergence(world.bootstrap.checks)).toBe(true);
  }
);

Then(
  'no installer is left running on {string}',
  async (world, name: string) => {
    expect(
      (
        await asRoot(
          named(world, name),
          "pgrep -f 'bootstrap/[b]ootstrap.sh|fleet-[b]ootstrap|apt-[g]et|mise [i]nstall'"
        )
      ).ok
    ).toBe(false);
    expect(await lockHeld(named(world, name))).toBe(false);
  }
);

Given(
  'another process holds the APT lock on {string}',
  async (world, name: string) => {
    const machine = named(world, name);
    world.defer(async () => {
      await asRoot(machine, "pkill -f 'fcntl[.]lockf'; true");
    });
    await startAsRoot(
      machine,
      'exec python3 -c \'import fcntl,time; f=open("/var/lib/dpkg/lock-frontend","w"); fcntl.lockf(f, fcntl.LOCK_EX); time.sleep(900)\''
    );
    expect(await waitFor(machine, "pgrep -f 'fcntl[.]lockf'", 20_000)).toBe(
      true
    );
  }
);

Given(
  'the name of the Ubuntu archive cannot be found on {string}',
  async (world, name: string) => {
    const machine = named(world, name);
    world.defer(async () => {
      await asRoot(
        machine,
        'cat /etc/resolv.conf.fleet-test > /etc/resolv.conf && rm -f /etc/resolv.conf.fleet-test'
      );
    });
    // Nothing answers DNS on the machine itself.
    const broken = await asRoot(
      machine,
      "cp /etc/resolv.conf /etc/resolv.conf.fleet-test && printf 'nameserver 127.0.0.1\\n' > /etc/resolv.conf"
    );
    expect(broken.ok).toBe(true);
  }
);

Given(
  'the host key the manager trusts for {string} is not the one it presents',
  async (world, name: string) => {
    const machine = named(world, name);
    world.machine = machine;
    const { scratch, knownHosts } = await sshClient();
    const original = await readFile(knownHosts, 'utf8');
    world.defer(() => writeFile(knownHosts, original));
    const other = join(scratch, `other-${name}`);
    await must(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', other]);
    const port = (await must(['docker', 'port', machine.container, '22/tcp']))
      .split('\n')[0]!
      .split(':')
      .at(-1)!;
    const replaced = original
      .split('\n')
      .filter((line) => !line.startsWith(`[127.0.0.1]:${port} `))
      .join('\n');
    await writeFile(
      knownHosts,
      `${replaced}\n${knownHostLine(port, await readFile(`${other}.pub`, 'utf8'))}`
    );
    fleet(world).before = (
      await asRoot(
        machine,
        'stat -c %i-%Y /home/fleettest/.config/dev-fleet/fleet.json'
      )
    ).stdout;
  }
);

Then('the bootstrap reports the check {string}', (world, id: string) => {
  expect(world.bootstrap.checks.map((check) => check.id)).toContain(id);
});

Then(
  'the fleet configuration on {string} was not written again',
  async (world, name: string) => {
    const now = await asRoot(
      named(world, name),
      'stat -c %i-%Y /home/fleettest/.config/dev-fleet/fleet.json'
    );
    expect(now.stdout).not.toBe('');
    expect(now.stdout).toBe(fleet(world).before ?? '');
  }
);

Then(
  '{string} still has none of these commands:',
  async (world, name: string, table: DataTable) => {
    for (const command of table.list())
      expect(
        `${command}: ${(await remote(named(world, name), `command -v ${command}`)).ok}`
      ).toBe(`${command}: false`);
  }
);

Then(
  'the package database of {string} is consistent',
  async (world, name: string) => {
    expect(
      (await asRoot(named(world, name), 'test -z "$(dpkg --audit)"')).ok
    ).toBe(true);
  }
);

/** An unattended upgrade, as far as dpkg can tell: the pinned package
 * rebuilt one revision past its pin and installed with dpkg. */
const PAST_PIN = '+fleettest1';
Given(
  'an update outside fleet-sync moved the pinned package {string} on {string} past its pin',
  async (world, pkg: string, name: string) => {
    const machine = named(world, name);
    const pinned = packagePins(ubuntuRelease(RELEASE_UNDER_TEST))[pkg]!;
    world.defer(async () => {
      await asRoot(
        machine,
        `apt-get install -y --allow-downgrades ${pkg}=${pinned} >/dev/null 2>&1; true`
      );
    });
    const moved = await asRoot(
      machine,
      [
        'set -e',
        'dir=$(mktemp -d) && cd "$dir"',
        `APT_CONFIG=/etc/personal-fleet/apt.conf apt-get download ${pkg}=${pinned} >/dev/null 2>&1 || apt-get download ${pkg} >/dev/null 2>&1`,
        `dpkg-deb -R ${pkg}_*.deb tree`,
        `sed -i 's/^Version: .*/&${PAST_PIN}/' tree/DEBIAN/control`,
        'dpkg-deb -b tree moved.deb >/dev/null',
        'dpkg -i moved.deb >/dev/null',
      ].join('\n'),
      300_000
    );
    expect(moved.ok).toBe(true);
  }
);

Then(
  'the bootstrap reports {string} as a warning that says {string}',
  (world, id: string, summary: string) => {
    const check = world.bootstrap.checks.find((entry) => entry.id === id);
    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain(summary);
  }
);

Then(
  'the package {string} on {string} is still past its pin',
  async (world, pkg: string, name: string) => {
    const version = await asRoot(
      named(world, name),
      `dpkg-query -W -f='\${Version}' ${pkg}`
    );
    expect(version.stdout.endsWith(PAST_PIN)).toBe(true);
  }
);
