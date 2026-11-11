import { expect } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import example from '../../examples/fleet.json';
import ubuntu from '../../ansible/ubuntu/policy.json';
import { parseDefinition } from '../../src/definition';
import { synchronizeManager, type ManagerReport } from '../../src/manager-sync';
import type { CommandResult, Runner } from '../../src/types';
import type { DataTable } from '../support/gherkin';
import { freshBox, type FreshBoxWorld } from './steps';
import {
  FLEET_ROOT,
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
  'these fresh Ubuntu {float} machines, each with only an SSH server and an account that can use sudo:',
  async (world, release: number, table: DataTable) => {
    expect(release.toFixed(2)).toBe(ubuntu.release);
    fleet(world).machines = await Promise.all(
      table.list().map((name) => box(name))
    );
  }
);

Given(
  'a fresh Ubuntu {float} machine {string} whose home has {int} MB free',
  async (world, release: number, name: string, megabytes: number) => {
    expect(release.toFixed(2)).toBe(ubuntu.release);
    expect(megabytes).toBe(64);
    const machine = await box(name, { smallHome: true });
    fleet(world).machines.push(machine);
    world.machine = machine;
  }
);

/** The machines are not on a tailnet: `tailscale status` and the SSH
 * aliases are answered as if each were online under its own name.
 */
const tailnet: Runner = (command, options) => {
  const names = command[0] === 'ssh' && command.includes('-G');
  if (names)
    return Promise.resolve(answer(`hostname ${command.at(-1)}.fleet.test\n`));
  return transport(command, options);
};
let tailnetMachines: string[] = [];
const answer = (stdout: string): CommandResult => ({
  ok: true,
  stdout,
  stderr: '',
  reason: 'exit',
});
const peer = (name: string, self = false) => ({
  ID: name,
  HostName: name,
  DNSName: `${name}.fleet.test.`,
  OS: self ? 'macOS' : 'linux',
  TailscaleIPs: [],
  Online: true,
});
const withTailnet: Runner = (command, options) =>
  command[0] === 'tailscale'
    ? Promise.resolve(
        answer(
          JSON.stringify({
            BackendState: 'Running',
            Self: peer('manager', true),
            Peer: Object.fromEntries(
              tailnetMachines.map((name) => [name, peer(name)])
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
        'grep -rls fleet-sync /etc/systemd /etc/cron.d /etc/crontab /var/spool/cron /home/fleettest/.config/systemd 2>/dev/null; true'
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
  'the second bootstrap reports {string} with a remedy',
  (world, code: string) => {
    const check = world.bootstrap.checks.find(
      (entry) => entry.summary === code
    );
    expect(check?.remedy?.action ?? '').not.toBe('');
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
  'the toolchain setup on {string} is killed while it runs',
  async (world, name: string) => {
    const machine = named(world, name);
    world.machine = machine;
    const interrupted = bootstrap(machine);
    // The character classes keep these patterns from matching the shell
    // that runs them.
    expect(
      await waitFor(
        machine,
        "pgrep -f 'bootstrap/[b]ootstrap.sh --worker'",
        300_000
      )
    ).toBe(true);
    const killed = await asRoot(
      machine,
      'group=$(ps -o pgid= -p "$(pgrep -f \'bootstrap/[b]ootstrap.sh --worker\' | head -1)" | tr -d \' \'); pkill -KILL -f \'fleet-[b]ootstrap\'; [ -z "$group" ] || kill -KILL -- "-$group"; true'
    );
    expect(killed.ok).toBe(true);
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
