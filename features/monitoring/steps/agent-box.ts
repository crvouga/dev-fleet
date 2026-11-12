import { expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import lock from '../../../ansible/monitoring/lock.json';
import { runCommand } from '../../../src/runner';
import type { DataTable } from '../../support/gherkin';
import { monitoring, type MonitoringWorld } from './world';

const { Given, When, Then } = monitoring;

const root = resolve(import.meta.dir, '../../..');
const image = 'dev-fleet-agent-box';
const AGENT = `/usr/local/lib/personal-beszel/${lock.version}/beszel-agent`;
const UNIT = '/etc/systemd/system/beszel-agent.service';

/** One disposable machine for the whole feature: building it and installing
 * the agent are too slow to repeat for every scenario.
 */
interface Box {
  container: string;
  installed?: Promise<void>;
}
let box: Promise<Box> | undefined;

async function must(command: string[], timeoutMs = 600_000): Promise<string> {
  const result = await runCommand(command, { cwd: root, timeoutMs });
  if (!result.ok)
    throw new Error(
      `${command.slice(0, 4).join(' ')} failed: ${result.stderr}`
    );
  return result.stdout.trim();
}

/** A command on the machine, as root. */
const on = (container: string, command: string) =>
  runCommand(['docker', 'exec', container, 'sh', '-c', command], {
    timeoutMs: 600_000,
  });

async function createBox(): Promise<Box> {
  await must([
    'docker',
    'build',
    '-q',
    '-t',
    image,
    '-f',
    'features/monitoring/support/agent-box.Dockerfile',
    'features/monitoring/support',
  ]);
  const container = `fleet-agent-box-${process.pid}`;
  // systemd as PID 1 needs the host's cgroups.
  await must([
    'docker',
    'run',
    '-d',
    '--name',
    container,
    '--privileged',
    '--cgroupns=host',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    image,
  ]);
  await booted(container);
  // The tracked playbooks, as a worker's checkout holds them.
  await must(['docker', 'cp', 'ansible/monitoring/.', `${container}:/m`]);
  return { container };
}

async function booted(container: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await on(container, 'systemctl is-system-running');
    if (['running', 'degraded'].includes(state.stdout.trim())) return;
    await Bun.sleep(500);
  }
  throw new Error('The machine did not boot.');
}

export async function discardAgentBox(): Promise<void> {
  if (!box) return;
  const created = await box.catch(() => null);
  if (created) await runCommand(['docker', 'rm', '-f', created.container]);
}

/** The variables fleet-sync delivers: a real key, a disposable token. */
async function variables(container: string, hub: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'fleet-agent-box-'));
  try {
    const key = join(scratch, 'key');
    await must(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
    const publicKey = (await readFile(`${key}.pub`, 'utf8'))
      .split(' ')
      .slice(0, 2)
      .join(' ');
    const file = join(scratch, 'vars.json');
    await writeFile(
      file,
      JSON.stringify({
        beszel_node: 'worker-one',
        beszel_hub_url: hub,
        beszel_public_key: publicKey,
        beszel_agent_token: 'disposable-fixture-token',
      })
    );
    await must(['docker', 'cp', file, `${container}:/m/vars.json`]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function apply(
  world: MonitoringWorld,
  playbook: string,
  flags = ''
): Promise<void> {
  const result = await on(
    world.box,
    `cd /m && ANSIBLE_NOCOLOR=1 ansible-playbook ${playbook} ${flags} --extra-vars @/m/vars.json`
  );
  expect(result.ok).toBe(true);
  world.output = result.stdout;
  const recap = /changed=(\d+)/.exec(result.stdout.split('PLAY RECAP').at(-1)!);
  world.changed = Number(recap?.[1]);
}

const mainPid = async (container: string) =>
  (
    await on(container, 'systemctl show -p MainPID --value beszel-agent')
  ).stdout.trim();

Given(
  'a disposable Ubuntu {float} machine booted with systemd',
  async (world, release: number) => {
    box ??= createBox();
    world.box = (await box).container;
    expect(
      (
        await on(world.box, '. /etc/os-release && echo "$VERSION_ID"')
      ).stdout.trim()
    ).toBe(release.toFixed(2));
  }
);

Given(
  'the agent was installed there by {string} for the hub {string}',
  async (world, playbook: string, hub: string) => {
    const created = await box!;
    created.installed ??= (async () => {
      await variables(created.container, hub);
      await apply(world, playbook);
    })();
    await created.installed;
    world.pid = await mainPid(world.box);
  }
);

Given(
  "someone changed {string} to {string} in the agent's unit",
  async (world, from: string, to: string) => {
    expect(
      (
        await on(
          world.box,
          `sed -i 's/${from}/${to}/' ${UNIT} && grep -q '${to}' ${UNIT}`
        )
      ).ok
    ).toBe(true);
  }
);

Given(
  'the agent is stopped and its executable was cut to {int} bytes',
  async (world, bytes: number) => {
    const cut = await on(
      world.box,
      `systemctl stop beszel-agent && head -c ${bytes} ${AGENT} > /tmp/cut && cp /tmp/cut ${AGENT} && test "$(stat -c %s ${AGENT})" = ${bytes}`
    );
    expect(cut.ok).toBe(true);
  }
);

When('{string} applies again', async (world, playbook: string) => {
  await apply(world, playbook);
});

When(
  '{string} is checked with --check --diff',
  async (world, playbook: string) => {
    await apply(world, playbook, '--check --diff');
  }
);

When('the machine restarts', async (world) => {
  await must(['docker', 'restart', world.box]);
  await booted(world.box);
});

Then('it changed nothing', (world) => {
  expect(world.changed).toBe(0);
});

Then('the tasks it reports as changing are:', (world, table: DataTable) => {
  const changing = world.output
    .split(/^(?:TASK|RUNNING HANDLER) \[/m)
    .filter((block) => /^changed: /m.test(block))
    .map((block) => block.slice(0, block.indexOf(']')));
  expect(changing).toEqual(table.list());
});

Then('its diff shows {string}', (world, text: string) => {
  expect(world.output).toContain(text);
});

Then("the agent's unit still says {string}", async (world, text: string) => {
  expect((await on(world.box, `cat ${UNIT}`)).stdout).toContain(text);
});

Then('the agent kept its process', async (world) => {
  expect(world.pid).not.toBe('0');
  expect(await mainPid(world.box)).toBe(world.pid);
});

Then('the agent is running', async (world) => {
  // Give a restarted unit a moment to settle; a crash loop shows as activating.
  await Bun.sleep(2000);
  expect(
    (await on(world.box, 'systemctl is-active beszel-agent')).stdout.trim()
  ).toBe('active');
});

Then(
  "the agent's unit is the tracked {string}",
  async (world, path: string) => {
    expect((await on(world.box, `cat ${UNIT}`)).stdout).toBe(
      await readFile(resolve(root, path), 'utf8')
    );
  }
);

Then(
  "the agent's executable is the build the Beszel lock pins for this machine",
  async (world) => {
    const machine = (await on(world.box, 'uname -m')).stdout.trim();
    const arch = ({ x86_64: 'amd64', aarch64: 'arm64' } as const)[
      machine as 'x86_64' | 'aarch64'
    ];
    expect(
      (await on(world.box, `sha256sum ${AGENT}`)).stdout.split(' ')[0]
    ).toBe(lock.agentBinaries[arch]);
  }
);

Then('nobody is signed in', async (world) => {
  expect(
    (
      await on(world.box, 'ls /run/systemd/sessions 2>/dev/null | wc -l')
    ).stdout.trim()
  ).toBe('0');
});

const status = async (world: MonitoringWorld) =>
  (
    await on(
      world.box,
      `cat /proc/$(systemctl show -p MainPID --value beszel-agent)/status`
    )
  ).stdout;

Then(
  "the agent's process runs as {string} with no capability and no way to gain one",
  async (world, user: string) => {
    const uid = (await on(world.box, `id -u ${user}`)).stdout.trim();
    const proc = await status(world);
    expect(proc).toMatch(new RegExp(`^Uid:\\s+${uid}\\s`, 'm'));
    expect(proc).toMatch(/^CapEff:\s+0+$/m);
    expect(proc).toMatch(/^NoNewPrivs:\s+1$/m);
  }
);

Then("the agent's process belongs to no group but its own", async (world) => {
  const gid = (await on(world.box, 'id -g beszel')).stdout.trim();
  expect((await status(world)).match(/^Groups:\s*(.*)$/m)?.[1]?.trim()).toBe(
    gid
  );
});

Then(
  'the account {string} cannot read the system journal',
  async (world, user: string) => {
    const read = await on(
      world.box,
      `setpriv --reuid=${user} --regid=${user} --clear-groups journalctl -n 1 --no-pager -q 2>&1`
    );
    expect(read.stdout).toContain('insufficient permissions');
  }
);

Then(
  "the agent's process sees no home directory and cannot write to {string}",
  async (world, path: string) => {
    const pid = await mainPid(world.box);
    expect(
      (await on(world.box, `nsenter -t ${pid} -m ls -A /home`)).stdout.trim()
    ).toBe('');
    const write = await on(
      world.box,
      `nsenter -t ${pid} -m touch ${path}/fleet-check 2>&1`
    );
    expect(write.ok).toBe(false);
    expect(write.stdout).toContain('Read-only file system');
  }
);
