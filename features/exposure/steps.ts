import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import schema from '../../schema/fleet.schema.json';
import { conforms } from '../core/support/json-schema';
import { succeeded, failed } from '../support/commands';
import { CommandWorld, commandSteps } from '../support/command-steps';
import { steps, type DataTable } from '../support/gherkin';
import {
  DefinitionError,
  parseDefinition,
  type FleetDefinition,
} from '../../src/definition';
import {
  effectiveExposure,
  parseExposure,
  workerExposure,
  type ExposurePolicy,
} from '../../src/exposure';
import { exposureCheck } from '../../src/worker-exposure';
import {
  appendPublicReachability,
  publicEndpoints,
  publicReachabilityCheck,
  type Connect,
} from '../../src/public-reachability';
import { blocking, type NodeReport } from '../../src/types';

const ROOT = resolve(import.meta.dir, '../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

type Task = Record<string, unknown>;

/** One scenario: a fleet configuration, a worker's sockets and firewall, the
 * manager's view of its public address, and the checks reported. */
export class ExposureWorld extends CommandWorld {
  written: Record<string, unknown> | undefined;
  definition: FleetDefinition | undefined;
  exposure: ExposurePolicy | undefined;
  policy: ExposurePolicy = effectiveExposure(undefined, undefined);
  /** What `tailscale status --json` says of the peers. */
  status: Record<string, unknown> = { BackendState: 'Running', Peer: {} };
  accepting = new Set<number>();
  tried: string[] = [];
  reports: NodeReport[] = [];
  text = '';
  tasks: Task[] = [];

  readonly connect: Connect = async (host, port) => {
    this.tried.push(`${host.includes(':') ? `[${host}]` : host}:${port}`);
    return this.accepting.has(port);
  };
}

export const exposure = steps<ExposureWorld>();
commandSteps(exposure);
const { Given, When, Then } = exposure;

// ── The declared policy ─────────────────────────────────────────────────

Given('the fleet configuration of the example', (world) => {
  world.written = JSON.parse(read('examples/fleet.json')) as Record<
    string,
    unknown
  >;
});

Given('the worker policy declares the exposure:', (world, text: string) => {
  const policy = world.written!['worker'] as Record<string, unknown>;
  policy['exposure'] = JSON.parse(text);
});

Given('{string} declares the exposure:', (world, id: string, text: string) => {
  const workers = world.written!['workers'] as Record<string, unknown>[];
  workers.find((entry) => entry['id'] === id)!['exposure'] = JSON.parse(text);
});

When('the fleet configuration is read', (world) => {
  try {
    world.definition = parseDefinition(world.written);
  } catch (error) {
    world.failure = error;
  }
});

When('the exposure of {string} is read', (world, id: string) => {
  world.exposure = workerExposure(parseDefinition(world.written), id).policy;
});

Then('the exposure is:', (world, table: DataTable) => {
  const policy = world.exposure!;
  const shown: Record<string, string> = {
    publicSsh: String(policy.publicSsh),
    publicPorts:
      policy.publicPorts
        .map((entry) => `${entry.protocol}/${entry.port}`)
        .join(', ') || 'none',
    otherListeners: policy.otherListeners,
  };
  expect(shown).toEqual(Object.fromEntries(table.raw()));
});

Then('it is refused at {string}', (world, path: string) => {
  expect(world.failure).toBeInstanceOf(DefinitionError);
  expect((world.failure as DefinitionError).problem.path).toBe(path);
});

Then('the parser accepts it', (world) => {
  if (world.failure !== undefined) throw world.failure;
  expect(world.definition).toBeDefined();
});

Then('the schema accepts it', (world) => {
  expect(conforms(schema as Record<string, unknown>, world.written)).toBe(true);
});

// ── worker:exposure ─────────────────────────────────────────────────────

Given('a worker with these addresses:', (world, table: DataTable) => {
  const interfaces = new Map<string, { local: string; scope: string }[]>();
  for (const { interface: name, address } of table.hashes()) {
    const scope = name === 'lo' ? 'host' : 'global';
    interfaces.set(name!, [
      ...(interfaces.get(name!) ?? []),
      { local: address!, scope },
    ]);
  }
  world.commands.answer(
    (command) => command.join(' ') === 'ip -j address show',
    succeeded(
      JSON.stringify(
        [...interfaces].map(([ifname, addr_info]) => ({ ifname, addr_info }))
      )
    )
  );
});

Given(/^the worker (is|is not) a container$/, (world, is: string) => {
  world.commands.answer(
    (command) => command.join(' ') === 'systemd-detect-virt --container',
    is === 'is' ? succeeded('docker\n') : failed()
  );
});

const firewall = (publicSsh: boolean) =>
  JSON.stringify({
    nftables: [
      { metainfo: { json_schema_version: 1 } },
      { table: { family: 'inet', name: 'personal_fleet', handle: 1 } },
      {
        chain: {
          family: 'inet',
          table: 'personal_fleet',
          name: 'input',
          handle: 1,
          type: 'filter',
          hook: 'input',
          prio: -10,
          policy: 'drop',
        },
      },
      ...(publicSsh
        ? [
            {
              rule: {
                family: 'inet',
                table: 'personal_fleet',
                chain: 'input',
                handle: 9,
                comment: 'public-ssh',
                expr: [],
              },
            },
          ]
        : []),
    ],
  });

Given(
  /^the fleet firewall is (loaded|not loaded|loaded, keeping SSH open beyond the tailnet)$/,
  (world, state: string) => {
    world.commands.answer(
      (command) => command.join(' ').startsWith('sudo -n nft -j list table'),
      state === 'not loaded'
        ? failed('Error: No such file or directory')
        : succeeded(firewall(state !== 'loaded'))
    );
  }
);

Given('the exposure policy is:', (world, text: string) => {
  const declared = parseExposure(JSON.parse(text));
  expect(declared).not.toBeNull();
  world.policy = effectiveExposure(undefined, declared!);
});

Given('these sockets listen:', (world, table: DataTable) => {
  const lines = table.hashes().map((row, index) => {
    const pid = 1000 + index;
    const unit = row['unit'] ?? '';
    const [address, device] = (row['address'] ?? '').split('%');
    const host = address!.includes(':') ? `[${address}]` : address;
    const local = `${host}${device ? `%${device}` : ''}:${row['port']}`;
    const state = row['protocol'] === 'tcp' ? 'LISTEN' : 'UNCONN';
    // The command line of a process is never read: a token in it must not
    // reach a report.
    world.commands.answer(
      (command) => command.join(' ') === `cat /proc/${pid}/cgroup`,
      unit
        ? succeeded(`0::/system.slice/${unit}\n`)
        : failed('No such file or directory')
    );
    return `${row['protocol']}   ${state} 0      4096   ${local}   0.0.0.0:*    users:(("server --token=PRIVATE",pid=${pid},fd=3))`;
  });
  world.commands.answer(
    (command) => command.join(' ') === 'sudo -n ss -H -l -n -t -u -p',
    succeeded(lines.join('\n') + '\n')
  );
});

When('the exposure of the worker is checked', async (world) => {
  world.checks = [
    await exposureCheck(
      { policy: world.policy, sshPort: 22, t3Port: 3773 },
      world.run
    ),
  ];
});

Then('the check is not applicable', (world) => {
  expect(world.check.status).toBe('not-applicable');
});

Then('the summary of the check mentions {string}', (world, text: string) => {
  expect(world.check.summary).toContain(text);
});

// ── worker:public-reachability ──────────────────────────────────────────

Given(
  'Tailscale reaches {string} at {string}',
  (world, name: string, endpoints: string) => {
    const peers = world.status['Peer'] as Record<string, unknown>;
    peers[`nodekey:${Object.keys(peers).length}`] = {
      DNSName: `${name}.`,
      Addrs: endpoints
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
    world.commands.answer(
      (command) => command.join(' ') === 'tailscale status --json',
      () => succeeded(JSON.stringify(world.status))
    );
  }
);

Given('no port accepts a connection', (world) => {
  world.accepting.clear();
});

Given('port {int} accepts a connection', (world, port: number) => {
  world.accepting.add(port);
});

When(
  'the public reachability of {string} is checked',
  async (world, id: string) => {
    const machine = parseDefinition(
      JSON.parse(read('examples/fleet.json'))
    ).workers.find((entry) => entry.id === id)!;
    world.checks = [
      await publicReachabilityCheck(
        {
          policy: world.policy,
          sshPort: machine.network!.sshPort,
          t3Port: machine.network!.t3Port,
        },
        publicEndpoints(world.status, machine.network!.tailscaleName),
        world.connect
      ),
    ];
  }
);

When(
  'the manager adds public reachability to the reports of:',
  async (world, table: DataTable) => {
    world.reports = table.list().map((node) => ({ node, checks: [] }));
    await appendPublicReachability(world.reports, world.run, world.connect);
  }
);

Then('only these connections were tried:', (world, table: DataTable) => {
  expect(world.tried).toEqual(table.list());
});

Then('no connection was tried', (world) => {
  expect(world.tried).toEqual([]);
});

Then('the check does not block readiness', (world) => {
  expect(blocking(world.check)).toBe(false);
});

Then(
  'the report of {string} holds {string} as {string}',
  (world, node: string, id: string, status: string) => {
    const report = world.reports.find((entry) => entry.node === node)!;
    expect(
      report.checks
        .filter((check) => check.id === id)
        .map((check): string => check.status)
    ).toEqual([status]);
  }
);

// ── What the playbooks declare ──────────────────────────────────────────

const RULES = 'ansible/ubuntu/firewall.nft.j2';
const FIREWALL = 'ansible/ubuntu/tasks/firewall.yml';
const SSH = 'ansible/ubuntu/tasks/ssh.yml';

/** The lines of one chain of the template, `{% … %}` lines included. */
function chain(text: string, name: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `chain ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === '}'
  );
  return lines.slice(start + 1, end).map((line) => line.trim());
}

/** The `{% if %}` conditions in force at each line of the template. */
function conditionsAt(text: string): { line: string; when: string[] }[] {
  const open: string[] = [];
  const result: { line: string; when: string[] }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const start = /^\{% if (.+?) %\}$/.exec(line);
    if (start) open.push(start[1]!);
    else if (line === '{% endif %}') open.pop();
    else result.push({ line, when: [...open] });
  }
  return result;
}

When('the firewall rules the baseline loads are read', (world) => {
  world.text = read(RULES);
});

Then('the input chain drops what no rule accepts', (world) => {
  expect(chain(world.text, 'input')[0]).toBe(
    'type filter hook input priority filter - 10; policy drop;'
  );
});

Then(
  'the input chain accepts traffic on these interfaces:',
  (world, table: DataTable) => {
    const policy = JSON.parse(read('ansible/ubuntu/policy.json')) as {
      exposure: { tailnetInterface: string };
    };
    const input = chain(world.text, 'input').map((line) =>
      line.replace(
        '{{ exposure.tailnetInterface }}',
        policy.exposure.tailnetInterface
      )
    );
    for (const name of table.list())
      expect(
        input.some(
          (line) =>
            line === `iif "${name}" accept` ||
            line === `iifname "${name}" accept`
        )
      ).toBe(true);
  }
);

Then(
  "the input chain accepts UDP to tailscaled's port {int}",
  (world, port: number) => {
    const policy = JSON.parse(read('ansible/ubuntu/policy.json')) as {
      exposure: { tailscalePort: number };
    };
    expect(policy.exposure.tailscalePort).toBe(port);
    expect(chain(world.text, 'input')).toContain(
      'udp dport {{ exposure.tailscalePort }} accept comment "tailscaled"'
    );
  }
);

Then(
  'the SSH port is accepted beyond the tailnet only by a rule marked {string}, written only when {string} holds',
  (world, comment: string, condition: string) => {
    const ssh = conditionsAt(world.text).filter(({ line }) =>
      /^tcp dport .* accept/.test(line)
    );
    expect(ssh.map(({ line }) => line)).toEqual([
      `tcp dport {{ port }} accept comment "${comment}"`,
    ]);
    expect(ssh[0]!.when).toEqual([`${condition} | bool`]);
  }
);

Then(
  'the forward chain is written only when {string} holds',
  (world, condition: string) => {
    const forward = conditionsAt(world.text).filter(
      ({ line }) => line === 'chain forward {'
    );
    expect(forward.map(({ when }) => when)).toEqual([[`${condition} | bool`]]);
  }
);

Then(
  'the forward chain drops connections Docker translated that arrived from outside the tailnet',
  (world) => {
    const forward = chain(world.text, 'forward');
    const tailnet = forward.indexOf(
      'iifname "{{ exposure.tailnetInterface }}" accept'
    );
    const drop = forward.indexOf(
      'ct status dnat drop comment "container-port"'
    );
    expect(forward[0]).toContain('policy accept;');
    expect(tailnet).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(tailnet);
  }
);

const tasksOf = (path: string): Task[] => parse(read(path)) as Task[];
const named = (tasks: Task[], name: string): Task => {
  const task = tasks.find((entry) => entry['name'] === name);
  expect(task, `no task "${name}"`).toBeDefined();
  return task!;
};

When('the baseline playbook is read', (world) => {
  const [play] = parse(read('ansible/ubuntu/baseline.yml')) as Task[];
  world.tasks = play!['tasks'] as Task[];
});

Then(
  'it applies {string} after {string}',
  (world, later: string, earlier: string) => {
    const index = (file: string) =>
      world.tasks.findIndex(
        (task) => task['ansible.builtin.import_tasks'] === file
      );
    expect(index(earlier)).toBeGreaterThanOrEqual(0);
    expect(index(later)).toBeGreaterThan(index(earlier));
  }
);

Then(
  'it applies {string} unless the machine is a container',
  (world, file: string) => {
    const task = world.tasks.find(
      (entry) => entry['ansible.builtin.import_tasks'] === file
    )!;
    expect(String(task['when'])).toContain(
      "ansible_facts.virtualization_type not in ['docker', 'container', 'podman', 'lxc', 'systemd-nspawn']"
    );
  }
);

When('the firewall tasks are read', (world) => {
  world.tasks = tasksOf(FIREWALL);
});

Then(
  'the public SSH port stays open when any of these holds:',
  (world, table: DataTable) => {
    const decide = named(
      world.tasks,
      'Decide whether the public SSH path may close'
    );
    const facts = decide['ansible.builtin.set_fact'] as Record<string, string>;
    const terms = facts['firewall_public_ssh']!.replace(/^\{\{|\}\}$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' or ')
      .map((term) => term.trim().replace(/^\((.*)\)$/, '$1'));
    expect(terms).toEqual(table.list());
  }
);

const block = (world: ExposureWorld): Task =>
  named(
    world.tasks,
    'Apply the rules and verify the tailnet path, or restore the previous ones'
  );

Then(
  'one block writes the rules, loads them and then verifies, in this order:',
  (world, table: DataTable) => {
    const tasks = block(world)['block'] as Task[];
    expect(tasks.map((task) => task['name'])).toEqual(table.list());
    const verify = tasks.slice(2);
    for (const task of verify)
      expect(String(task['when'])).toContain('not firewall_public_ssh | bool');
  }
);

Then(
  'its rescue restores the previous rules, reloads them and fails with {string} or {string}',
  (world, rejected: string, unverified: string) => {
    const rescue = block(world)['rescue'] as Task[];
    const restore = rescue.find(
      (task) =>
        (task['ansible.builtin.copy'] as Task | undefined)?.['content'] ===
        '{{ firewall_previous.content | b64decode }}'
    );
    const reload = rescue.find(
      (task) =>
        (task['ansible.builtin.systemd_service'] as Task | undefined)?.[
          'state'
        ] === 'restarted'
    );
    const last = rescue.at(-1)!['ansible.builtin.fail'] as Task;
    expect(restore).toBeDefined();
    expect(rescue.indexOf(reload!)).toBeGreaterThan(rescue.indexOf(restore!));
    expect(String(last['msg'])).toStartWith(
      `{{ '${rejected}' if firewall_rules is defined and firewall_rules is failed else '${unverified}' }};`
    );
  }
);

When('the SSH tasks are read', (world) => {
  world.tasks = tasksOf(SSH);
});

const stage = (world: ExposureWorld): Task =>
  named(
    world.tasks,
    'Stage and validate forwarding and authentication policy while preserving listeners'
  );

Then('{string} is written with:', (world, path: string, table: DataTable) => {
  const written = (stage(world)['block'] as Task[])
    .map((task) => task['ansible.builtin.copy'] as Task | undefined)
    .find((copy) => copy?.['dest'] === path);
  expect(written).toBeDefined();
  const lines = String(written!['content']).trim().split('\n');
  expect(lines[0]).toStartWith('# Managed by personal Fleet');
  expect(lines.slice(1)).toEqual(table.list());
});

Then(
  'a rejected configuration restores both fragments before sshd is reloaded',
  (world) => {
    const restored = (stage(world)['rescue'] as Task[])
      .map((task) => task['ansible.builtin.copy'] as Task | undefined)
      .filter(Boolean)
      .map((copy) => copy!['dest']);
    expect(restored).toEqual([
      '/etc/ssh/sshd_config.d/60-personal-fleet.conf',
      '/etc/ssh/sshd_config.d/10-personal-fleet-exposure.conf',
    ]);
    const reload = world.tasks.findIndex(
      (task) =>
        (task['ansible.builtin.systemd_service'] as Task | undefined)?.[
          'state'
        ] === 'reloaded'
    );
    expect(reload).toBeGreaterThan(world.tasks.indexOf(stage(world)));
  }
);

Then(
  'after reload {string} must show, or fail with {string}:',
  (world, _command: string, code: string, table: DataTable) => {
    const assertion = named(
      world.tasks,
      'Require keys-only authentication without root login after reload'
    )['ansible.builtin.assert'] as Task;
    expect(assertion['that']).toEqual(
      table.list().map((line) => `'${line}' in ssh_verified.stdout_lines`)
    );
    expect(String(assertion['fail_msg'])).toStartWith(`${code};`);
  }
);
