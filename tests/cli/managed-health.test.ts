import { expect, test } from 'bun:test';
import { managedHealthScope } from '../../src/cli/managed-health';
import definition from '../../examples/fleet.json';
import type { TailnetComputer } from '../../src/tailscale';

const peer = (dns: string, self = false): TailnetComputer => ({
  id: dns,
  name: dns,
  dns,
  os: 'linux',
  ips: ['100.64.0.1'],
  online: true,
  self,
});
test('managed health retains manager and canonical nodes, exposes excluded service peers and missing enrollments', () => {
  const computers = [
    peer('manager', true),
    ...definition.workers.map((node) => peer(node.network.tailscaleName)),
    peer('service.example'),
  ];
  const result = managedHealthScope(
    { computers, excludedMobile: 1, checks: [] },
    []
  );
  expect(result.tailnet.computers).toHaveLength(3);
  expect(result.excluded).toEqual(['service.example']);
  expect(result.tailnet.checks).toHaveLength(2);
  expect(result.tailnet.checks.every((check) => check.status === 'fail')).toBe(
    true
  );
});
test('declared registrations are retained, unrelated roster entries do not expand managed coverage', () => {
  const nodes = [
    ...definition.workers.map((node) => ({
      id: node.id,
      ssh: node.ssh,
      workspace: '/repo',
      required: [],
    })),
    { id: 'service', ssh: 'service', workspace: '/service', required: [] },
  ];
  const result = managedHealthScope(
    { computers: [], excludedMobile: 0, checks: [] },
    nodes
  );
  expect(result.nodes).toHaveLength(2);
  expect(result.tailnet.checks).toEqual([]);
});
