import { afterEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tailnetHealth } from './tailnet-health';
import { probe } from './probe';
import { gitRunner, NODE, success, workspace } from './test-fixtures';
import type { Tailnet, TailnetComputer } from './tailscale';
import type { Runner } from './types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
function computer(id: string, online = true, self = false): TailnetComputer {
  return {
    id,
    name: id,
    dns: `${id}.tailnet.ts.net`,
    os: 'linux',
    ips: ['100.64.0.2'],
    online,
    self,
  };
}
async function options() {
  const root = await workspace();
  roots.push(root);
  return { root, timeoutMs: 300_000, source: async () => 'test-probe-source' };
}
function tailnet(computers: TailnetComputer[]): Tailnet {
  return {
    computers,
    excludedMobile: 1,
    checks: [{ id: 'tailscale:discovery', status: 'pass', summary: 'fixture' }],
  };
}

test('every discovered computer is accounted for: offline, unregistered and manager', async () => {
  const calls: string[][] = [];
  const run: Runner = async (command) => {
    calls.push(command);
    return gitRunner(command);
  };
  const reports = await tailnetHealth(
    tailnet([
      computer('manager', true, true),
      computer('offline', false),
      computer('unregistered'),
    ]),
    [],
    await options(),
    run
  );
  expect(reports.map((report) => report.node)).toEqual([
    'tailscale',
    'manager.tailnet.ts.net',
    'offline.tailnet.ts.net',
    'unregistered.tailnet.ts.net',
  ]);
  expect(
    reports[2]?.checks.some(
      (check) => check.id === 'tailscale:online' && check.status === 'fail'
    )
  ).toBe(true);
  expect(
    reports[3]?.checks.some(
      (check) => check.id === 'fleet:registration' && check.status === 'fail'
    )
  ).toBe(true);
  expect(calls.filter((command) => command[0] === 'ssh')).toHaveLength(0);
  expect(calls.filter((command) => command[0] === 'tailscale')).toHaveLength(1);
});

test('registered online computers receive only their declared capabilities', async () => {
  const settings = await options();
  const snapshot = await probe(settings.root, [], gitRunner);
  const ssh: string[][] = [];
  const run: Runner = async (command, opts) => {
    if (command[0] === 'ssh' && command.includes('-G'))
      return success('hostname remote.tailnet.ts.net\n');
    if (command[0] !== 'ssh') return gitRunner(command);
    ssh.push(command);
    expect(command).toContain('StrictHostKeyChecking=yes');
    expect(opts?.input).toBe('test-probe-source');
    const encoded = /'([^']+)'$/.exec(command.at(-1)!)![1]!;
    const request = JSON.parse(Buffer.from(encoded, 'base64').toString()) as {
      node: { required: string[] };
    };
    expect(request.node.required).toEqual(NODE.required);
    expect(request.node.required).not.toContain('services');
    return success(JSON.stringify(snapshot));
  };
  const reports = await tailnetHealth(
    tailnet([computer('remote')]),
    [{ ...NODE, workspace: settings.root }],
    settings,
    run
  );
  expect(ssh).toHaveLength(1);
  expect(
    reports.find((report) => report.node === 'remote.tailnet.ts.net')?.snapshot
  ).toBeDefined();
});

test('ambiguous mappings never execute SSH probes; registered devices absent from inventory fail explicitly', async () => {
  let probes = 0;
  const run: Runner = async (command) => {
    if (command[0] === 'ssh' && command.includes('-G'))
      return success(
        `hostname ${command.at(-1) === 'absent' ? 'hidden' : 'remote'}.tailnet.ts.net\n`
      );
    if (command[0] === 'ssh') probes += 1;
    return gitRunner(command);
  };
  const nodes = [
    NODE,
    { ...NODE, id: 'duplicate' },
    { ...NODE, id: 'hidden', ssh: 'absent' },
  ];
  const reports = await tailnetHealth(
    tailnet([computer('remote')]),
    nodes,
    await options(),
    run
  );
  expect(probes).toBe(0);
  expect(
    reports
      .find((report) => report.node === 'remote.tailnet.ts.net')
      ?.checks.some(
        (check) => check.id === 'fleet:registration' && check.status === 'fail'
      )
  ).toBe(true);
  expect(
    reports.find((report) => report.node === 'hidden')?.checks[0]?.id
  ).toBe('tailscale:membership');
});

test('probe preparation failure preserves every computer and never exposes exception text', async () => {
  const settings = await options();
  let preparations = 0;
  const reports = await tailnetHealth(
    tailnet([computer('remote'), computer('other')]),
    [
      { ...NODE, ssh: 'remote' },
      { ...NODE, id: 'other', ssh: 'other' },
    ],
    {
      ...settings,
      source: async () => {
        preparations += 1;
        throw new Error('private-secret');
      },
    },
    async (command) =>
      command.includes('-G')
        ? success(`hostname ${command.at(-1)}.tailnet.ts.net\n`)
        : gitRunner(command)
  );
  expect(preparations).toBe(1);
  for (const name of ['remote', 'other']) {
    expect(
      reports
        .find((report) => report.node === `${name}.tailnet.ts.net`)
        ?.checks.some(
          (check) => check.id === 'fleet:probe' && check.status === 'fail'
        )
    ).toBe(true);
  }
  expect(JSON.stringify(reports)).not.toContain('private-secret');
});

test('one SSH alias matching two computers cannot inspect either computer', async () => {
  let probes = 0;
  const reports = await tailnetHealth(
    tailnet([
      computer('remote'),
      { ...computer('other'), dns: 'remote.second.ts.net' },
    ]),
    [{ ...NODE, ssh: 'remote' }],
    await options(),
    async (command) => {
      if (command.includes('-G')) return success('hostname remote\n');
      if (command[0] === 'ssh') probes += 1;
      return gitRunner(command);
    }
  );
  expect(probes).toBe(0);
  expect(
    reports.filter((report) =>
      report.checks.some(
        (check) => check.id === 'fleet:registration' && check.status === 'fail'
      )
    )
  ).toHaveLength(2);
});
