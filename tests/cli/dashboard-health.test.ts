import { expect, test } from 'bun:test';
import {
  appendDashboardEvidence,
  dashboardUrl,
} from '../../src/cli/managed-health';
import definition from '../../examples/fleet.json';
import type { NodeReport } from '../../src/types';
import type { Tailnet } from '../../src/tailscale';

const manager = definition.manager;
const tailnet: Tailnet = {
  excludedMobile: 0,
  checks: [],
  computers: [
    {
      id: 'id-manager',
      name: manager.id,
      dns: manager.network.tailscaleName,
      os: 'macOS',
      ips: ['100.64.0.2'],
      online: true,
      self: true,
    },
  ].concat(
    definition.workers.map((node) => ({
      id: `id-${node.id}`,
      name: node.id,
      dns: node.network.tailscaleName,
      os: 'linux',
      ips: ['100.64.0.1'],
      online: true,
      self: false,
    }))
  ),
};
const healthy = (path: string): unknown => {
  if (path === '/api/beszel/info') return { v: '0.21.1', key: 'ssh-ed25519 x' };
  if (path.startsWith('/api/collections/systems/records'))
    return { items: [{ id: 'a'.repeat(15), status: 'up' }] };
  return { items: [{ created: new Date().toISOString() }] };
};
const ok = async () => new Response('{}', { status: 200 });

test('the dashboard is the hub on the manager, reached by its MagicDNS name', () => {
  expect(dashboardUrl(tailnet)).toBe(
    `https://${manager.network.tailscaleName}:8443`
  );
  expect(dashboardUrl({ ...tailnet, computers: [] })).toBeNull();
});

test('every canonical worker gets registration, connection and freshness evidence', async () => {
  const reports: NodeReport[] = definition.workers.map((node) => ({
    node: node.network.tailscaleName,
    checks: [],
  }));
  const hub = await appendDashboardEvidence(reports, tailnet, {
    fetcher: ok as unknown as typeof fetch,
    access: async () => ({ request: async (path) => healthy(path) }),
  });
  expect(hub).toBe(`https://${manager.network.tailscaleName}:8443`);
  const dashboard = reports.find((report) => report.node === 'dashboard')!;
  expect(dashboard.checks).toEqual([
    expect.objectContaining({ id: 'beszel:hub', status: 'pass' }),
    expect.objectContaining({ id: 'beszel:public-endpoint', status: 'pass' }),
  ]);
  for (const node of definition.workers) {
    const report = reports.find(
      (entry) => entry.node === node.network.tailscaleName
    )!;
    expect(report.checks.map((check) => check.id)).toEqual([
      'beszel:version',
      'beszel:registration',
      'beszel:connection',
      'beszel:freshness',
    ]);
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
  }
});

test('an unreachable hub or missing manager Vault session is reported, never passed', async () => {
  const reports: NodeReport[] = [];
  await appendDashboardEvidence(reports, tailnet, {
    fetcher: (async () => {
      throw new Error('private connection detail');
    }) as unknown as typeof fetch,
    access: async () => {
      throw new Error('BESZEL_ACCOUNT_REQUIRED');
    },
  });
  const dashboard = reports.find((report) => report.node === 'dashboard')!;
  expect(dashboard.checks.map((check) => [check.id, check.status])).toEqual([
    ['beszel:hub', 'fail'],
    ['beszel:public-endpoint', 'warn'],
    ['beszel:access', 'skip'],
  ]);
  expect(JSON.stringify(reports)).not.toContain('private connection detail');
  expect(
    await appendDashboardEvidence([], { ...tailnet, computers: [] })
  ).toBeNull();
});
