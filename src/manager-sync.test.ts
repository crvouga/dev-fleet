import { expect, test } from 'bun:test';
import { blocksPromotion, synchronizeManager } from './manager-sync';
import { parseDefinition } from './definition';
import source from '../examples/fleet.json';
import type { FleetNode, Runner } from './types';
const revision = 'a'.repeat(40);
const definition = parseDefinition({
  ...source,
  workers: [
    { id: 'first', ssh: 'first', os: 'linux' },
    { id: 'second', ssh: 'second', os: 'linux' },
  ],
});
const nodes: FleetNode[] = ['first', 'second'].map((id) => ({
  id,
  ssh: id,
  workspace: `/home/dev/${id}`,
  required: [],
  tailscaleId: id,
}));
const ok = (stdout: string) => ({
  ok: true,
  stdout,
  stderr: '',
  reason: 'exit' as const,
});
function runner(offline = false): Runner {
  const peer = (name: string, online = true) => ({
    ID: name,
    HostName: name,
    DNSName: `${name}.example.ts.net.`,
    OS: 'linux',
    TailscaleIPs: ['100.64.0.1'],
    Online: online,
  });
  return async (command) => {
    if (command[0] === 'tailscale')
      return ok(
        JSON.stringify({
          BackendState: 'Running',
          Self: peer('manager'),
          Peer: {
            first: peer('first'),
            second: peer('second', !offline),
            candidate: peer('unapproved'),
          },
        })
      );
    if (command.includes('-G'))
      return ok(`hostname ${command.at(-1)}.example.ts.net\n`);
    return ok('ubuntu\n26.04\nx86_64\n');
  };
}
test('one manager invocation uses one revision and never deploys a candidate', async () => {
  const deployed: string[] = [];
  const result = await synchronizeManager(
    { definition, nodes, revision, apply: true },
    runner(),
    async (node, sha) => {
      expect(sha).toBe(revision);
      deployed.push(node.id);
      return {
        node: node.id,
        checks: [{ id: 'verified', status: 'pass', summary: 'fixture' }],
      };
    }
  );
  expect(deployed).toEqual(['first', 'second']);
  expect(result.candidates).toBe(1);
  expect(result.nodes.map((node) => node.node)).toEqual(['first', 'second']);
});
test('offline node stays visible while independent reachable node proceeds', async () => {
  const deployed: string[] = [];
  const result = await synchronizeManager(
    { definition, nodes, revision, apply: true },
    runner(true),
    async (node) => {
      deployed.push(node.id);
      return {
        node: node.id,
        checks: [{ id: 'done', status: 'pass', summary: 'fixture' }],
      };
    }
  );
  expect(deployed).toEqual(['first']);
  expect(result.nodes[1]?.reachability).toBe('offline');
  expect(result.ok).toBe(false);
});
test('failed canary blocks promotion but does not omit other diagnostics', async () => {
  const deployed: string[] = [];
  const result = await synchronizeManager(
    { definition, nodes, revision, apply: true, canary: 'first' },
    runner(),
    async (node) => {
      deployed.push(node.id);
      throw new Error('secret detail');
    }
  );
  expect(deployed).toEqual(['first']);
  expect(
    result.nodes[1]?.checks.some((check) => check.id === 'ssh:fresh-session')
  ).toBe(true);
  expect(result.nodes[1]?.checks.at(-1)?.summary).toBe(
    'FLEET_PROMOTION_BLOCKED'
  );
  expect(JSON.stringify(result)).not.toContain('secret detail');
});
test('dry run neither bootstraps nor deploys; missing overrides remain accounted for', async () => {
  const result = await synchronizeManager(
    { definition, nodes: nodes.slice(0, 1), revision, apply: false },
    runner(),
    async () => {
      throw new Error('must not deploy');
    }
  );
  expect(result.nodes).toHaveLength(2);
  expect(result.nodes[1]?.checks[0]?.summary).toBe('FLEET_CONNECTION_REQUIRED');
  expect(result.applied).toBe(false);
});
test('device replacement blocks writes even when SSH succeeds', async () => {
  const result = await synchronizeManager(
    {
      definition,
      nodes: nodes.map((node) => ({ ...node, tailscaleId: 'old' })),
      revision,
      apply: true,
    },
    runner(),
    async () => {
      throw new Error('must not deploy');
    }
  );
  expect(result.applied).toBe(false);
  expect(
    result.nodes.every((node) =>
      node.checks.some((check) => check.summary === 'TAILSCALE_DEVICE_REPLACED')
    )
  ).toBe(true);
});

test('an explicitly authorized trusted SSH bootstrap route may repair an offline node', async () => {
  const deployed: string[] = [];
  const result = await synchronizeManager(
    {
      definition,
      nodes: nodes.map((node) => ({ ...node, bootstrapViaSsh: true })),
      revision,
      apply: true,
    },
    runner(true),
    async (node) => {
      deployed.push(node.id);
      return {
        node: node.id,
        checks: [
          {
            id: 'fixture:apply',
            status: 'pass',
            summary: 'Applied; no fresh tailnet evidence supplied.',
          },
        ],
      };
    }
  );
  expect(deployed).toEqual(['first', 'second']);
  expect(result.ok).toBe(false);
  expect(result.nodes[1]?.reachability).toBe('offline');
});
test('bootstrap authorization never permits a changed device identity', async () => {
  const result = await synchronizeManager(
    {
      definition,
      nodes: nodes.map((node) => ({
        ...node,
        bootstrapViaSsh: true,
        tailscaleId: 'replaced',
      })),
      revision,
      apply: true,
    },
    runner(),
    async () => {
      throw new Error('must not deploy');
    }
  );
  expect(result.applied).toBe(false);
});

test('missing monitoring or client pairing remains incomplete without blocking independent node configuration', async () => {
  const deployed: string[] = [];
  const result = await synchronizeManager(
    { definition, nodes, revision, apply: true, canary: 'first' },
    runner(),
    async (node) => {
      deployed.push(node.id);
      return {
        node: node.id,
        checks: [
          {
            id: 'beszel:enrollment',
            status: 'fail',
            summary: 'BESZEL_ACCOUNT_REQUIRED',
          },
          {
            id: 't3:end-to-end',
            status: 'skip',
            summary: 'REQUIRED_ACCEPTANCE_UNVERIFIED',
          },
        ],
      };
    }
  );
  expect(deployed).toEqual(['first', 'second']);
  expect(result.ok).toBe(false);
  expect(result.nodes.every((node) => node.appliedRevision === null)).toBe(
    true
  );
});

test('maintenance-class T3 outcomes and external acceptance never block promotion; configuration failures do', () => {
  const failing = (id: string, summary: string) =>
    blocksPromotion({ id, status: 'fail', summary });
  expect(failing('t3:service', 'T3_LISTENER_CONFLICT')).toBe(false);
  expect(failing('t3:service', 'T3_MAINTENANCE_REQUIRED')).toBe(false);
  expect(failing('t3:service', 'T3_SERVICE_INSTALLATION_FAILED')).toBe(true);
  expect(
    failing('ubuntu:boot-policy', 'UBUNTU_MAINTENANCE_REBOOT_PENDING')
  ).toBe(false);
  expect(failing('beszel:enrollment', 'BESZEL_ACCOUNT_REQUIRED')).toBe(false);
  expect(failing('t3:paired-access', 'MANAGER_T3_LINK_UNVERIFIED')).toBe(false);
  expect(failing('ubuntu:baseline', 'UBUNTU_BASELINE_INCOMPLETE')).toBe(true);
  expect(
    failing('workstation:installation', 'WORKSTATION_INSTALLATION_FAILED')
  ).toBe(true);
  expect(
    blocksPromotion({ id: 'ubuntu:baseline', status: 'pass', summary: 'ok' })
  ).toBe(false);
});

test('warnings and skips are reported but a run with no failure succeeds', async () => {
  const finished: string[] = [];
  const result = await synchronizeManager(
    {
      definition,
      nodes,
      revision,
      apply: true,
      finished: (n) => finished.push(n.node),
    },
    runner(),
    async (node) => ({
      node: node.id,
      checks: [
        { id: 'configuration:apply', status: 'pass', summary: 'ok' },
        {
          id: 'provider:codex:inference',
          status: 'warn',
          summary: 'PROVIDER_UPSTREAM_UNAVAILABLE',
        },
        {
          id: 'worker:power-loss-recovery',
          status: 'skip',
          summary: 'unobservable',
        },
      ],
    })
  );
  expect(result.ok).toBe(true);
  expect(result.nodes.map((n) => n.appliedRevision)).toEqual([
    revision,
    revision,
  ]);
  expect(finished).toEqual(['first', 'second']);
});
