import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  enrollManagerMonitoring,
  synchronizeMonitoring,
  synchronizeMonitoringWith,
} from '../../src/cli/fleet-sync-monitoring';
import { loadDefinition } from '../../src/definition';
import type { CommandResult, FleetNode, Runner } from '../../src/types';

const definition = loadDefinition(
  resolve(import.meta.dir, '../../examples/fleet.json')
);
const revision = 'a'.repeat(40);
const HUB = 'https://manager-mac-1.tail0a1b2c.ts.net:8443';
const worker: FleetNode = {
  id: 'worker-one',
  ssh: 'worker-one',
  workspace: '/unused',
  tailscaleId: 'worker-id',
  required: [],
};
const ok = (stdout = ''): CommandResult => ({
  ok: true,
  stdout,
  stderr: '',
  reason: 'exit',
});
const tailnet = JSON.stringify({
  BackendState: 'Running',
  Health: null,
  Self: {
    ID: 'manager-id',
    HostName: 'manager-mac',
    DNSName: 'manager-mac-1.tail0a1b2c.ts.net.',
    OS: 'macOS',
    Online: true,
    TailscaleIPs: ['100.64.0.1'],
  },
  Peer: {
    worker: {
      ID: 'worker-id',
      HostName: 'worker-one',
      DNSName: 'worker-one.tail0a1b2c.ts.net.',
      OS: 'linux',
      Online: true,
      TailscaleIPs: ['100.64.0.2'],
    },
  },
});

function fakeRunner(hubUp = true): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'curl')
      return hubUp ? ok() : { ...ok(), ok: false, reason: 'exit' };
    if (args[0] === 'tailscale') return ok(tailnet);
    return ok(
      JSON.stringify({
        version: 1,
        checks: [{ id: 'beszel:service', status: 'pass', summary: 'ok' }],
      })
    );
  };
  return { run, calls };
}

test('worker enrollment targets the manager hub and installs only the agent', async () => {
  const { run, calls } = fakeRunner();
  const hubs: string[] = [];
  const bodies: object[] = [];
  const checks = await synchronizeMonitoringWith({
    sampleDeadlineMs: 0,
    access: async (hub) => {
      hubs.push(hub);
      return {
        userId: 'abcdefghijklmno',
        request: async (path, body) => {
          if (body) {
            bodies.push(body);
            return body;
          }
          if (path.endsWith('/info'))
            return { v: '0.21.1', key: 'ssh-ed25519 fixture' };
          if (path.includes('/systems/')) return { items: [] };
          if (path.includes('/fingerprints/')) return { items: [] };
          return { items: [{ created: new Date().toISOString() }] };
        },
      };
    },
  })(worker, definition, revision, run);
  expect(hubs).toEqual([HUB]);
  expect(calls[0]).toContain(`${HUB}/api/health`);
  expect(bodies[0]).toMatchObject({
    name: 'worker-one',
    host: 'worker-one.tail0a1b2c.ts.net',
  });
  const ssh = calls.find((args) => args[0] === 'ssh') ?? [];
  expect(ssh.join(' ')).toContain('monitoring/apply.ts');
  expect(checks[0]?.id).toBe('beszel:service');
});

test('an unreachable manager hub stops before enrollment with a clear code', async () => {
  const { run, calls } = fakeRunner(false);
  const checks = await synchronizeMonitoringWith({
    access: async () => {
      throw new Error('must not log in');
    },
  })(worker, definition, revision, run);
  expect(checks[0]?.summary).toBe('BESZEL_HUB_UNREACHABLE');
  expect(checks[0]?.remedy?.action).toContain('runs on the manager');
  expect(calls.every((args) => args[0] === 'curl')).toBe(true);
});

test('the manager and unknown machines are never enrolled as workers', async () => {
  for (const id of ['manager-mac', 'unknown-node']) {
    const { run, calls } = fakeRunner();
    const checks = await synchronizeMonitoring(
      { ...worker, id, ssh: id },
      definition,
      revision,
      run
    );
    expect(checks[0]?.summary).toBe('BESZEL_NOT_ENROLLED');
    expect(calls).toEqual([]);
  }
});

test('a worker missing from the tailnet and a rejected login keep their codes', async () => {
  const missing = await synchronizeMonitoring(
    { ...worker, tailscaleId: 'absent' },
    definition,
    revision,
    fakeRunner().run
  );
  expect(missing[0]?.summary).toBe('BESZEL_NODE_TAILNET_REQUIRED');
  const rejected = await synchronizeMonitoringWith({
    access: async () => {
      throw new Error('BESZEL_ACCOUNT_REQUIRED');
    },
  })(worker, definition, revision, fakeRunner().run);
  expect(rejected[0]?.summary).toBe('BESZEL_ACCOUNT_REQUIRED');
  expect(rejected[0]?.remedy?.action).toContain('fleet-manager@example.com');
});

function hubFixture(bodies: object[]) {
  return async () => ({
    userId: 'abcdefghijklmno',
    request: async (path: string, body?: object) => {
      if (body) {
        bodies.push(body);
        return body;
      }
      if (path.endsWith('/info'))
        return { v: '0.21.1', key: 'ssh-ed25519 fixture' };
      if (path.includes('/systems/')) return { items: [] };
      if (path.includes('/fingerprints/')) return { items: [] };
      return {
        items: [
          {
            status: 'up',
            updated: new Date().toISOString(),
            created: new Date().toISOString(),
          },
        ],
      };
    },
  });
}

test('the manager enrolls itself on its own hub and installs its agent locally', async () => {
  const { run, calls } = fakeRunner();
  const bodies: object[] = [];
  const installs: { node: string; hubUrl: string }[] = [];
  const checks = await enrollManagerMonitoring(definition, '/checkout', run, {
    sampleDeadlineMs: 0,
    access: hubFixture(bodies),
    install: async (_root, { node, enrollment }) => {
      installs.push({ node, hubUrl: enrollment.hubUrl });
      return [{ id: 'beszel:service', status: 'pass', summary: 'ok' }];
    },
  });
  expect(bodies[0]).toMatchObject({
    name: 'manager-mac',
    host: 'manager-mac-1.tail0a1b2c.ts.net',
  });
  expect(installs).toEqual([{ node: 'manager-mac', hubUrl: HUB }]);
  expect(calls.some((args) => args[0] === 'ssh')).toBe(false);
  expect(checks[0]?.id).toBe('beszel:service');
});

test('a failed manager agent install is reported, never hidden', async () => {
  const checks = await enrollManagerMonitoring(
    definition,
    '/checkout',
    fakeRunner().run,
    {
      sampleDeadlineMs: 0,
      access: hubFixture([]),
      install: async () => [
        {
          id: 'beszel:installation',
          status: 'fail',
          summary: 'BESZEL_INSTALLATION_INCOMPLETE',
        },
      ],
    }
  );
  expect(checks.map((check) => check.summary)).toEqual([
    'BESZEL_INSTALLATION_INCOMPLETE',
  ]);
});

test('manager monitoring with an unreachable hub keeps its code', async () => {
  const checks = await enrollManagerMonitoring(
    definition,
    '/checkout',
    fakeRunner(false).run,
    {
      access: async () => {
        throw new Error('must not log in');
      },
    }
  );
  expect(checks[0]?.summary).toBe('BESZEL_HUB_UNREACHABLE');
});
