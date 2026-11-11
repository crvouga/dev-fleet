import { expect, test } from 'bun:test';
import { managerText, splitSummary } from '../../src/cli/fleet-sync-output';
import type { ManagerReport } from '../../src/manager-sync';
import type { Check } from '../../src/types';

const pass = (id: string): Check => ({ id, status: 'pass', summary: id });
const node = (name: string, checks: Check[], applied = 'abc') => ({
  node: name,
  role: 'worker',
  reachability: 'online',
  appliedRevision: applied,
  durationMs: 1000,
  checks,
});
const report = (nodes: unknown[], applied = true) =>
  ({
    desiredRevision: 'abcdef0123456789',
    applied,
    candidates: 0,
    dashboardUrl: 'https://beszel.example.com',
    checks: [],
    nodes,
  }) as unknown as ManagerReport;

const upstreamDown: Check = {
  id: 'provider:codex:inference',
  status: 'warn',
  summary: 'PROVIDER_UPSTREAM_UNAVAILABLE',
  remedy: { action: 'Retry later.' },
};

test('plain output is greppable: verdict, grid words and one line per problem', () => {
  const text = managerText(
    report([
      node(
        'w1',
        [
          pass('ssh:fresh-session'),
          pass('t3:service'),
          {
            id: 't3:paired-access',
            status: 'fail',
            summary: 'MANAGER_T3_LINK_UNVERIFIED',
            remedy: { action: 'Pair it.' },
          },
          upstreamDown,
        ],
        null as unknown as string
      ),
      node('w2', [pass('ssh:fresh-session'), upstreamDown]),
    ]),
    { reportPath: '/r/last-sync.json', durationMs: 65_000 }
  );
  expect(text.split('\n')[0]).toBe(
    'fleet-sync  ACTION REQUIRED  revision abcdef012345  in 1m05s'
  );
  expect(text).toMatch(
    /^w1 +worker +· +PASS +· +PASS +FAIL +WARN +· +· +1 failing$/m
  );
  expect(text).toMatch(/^w2 +worker +· +PASS +· +· +· +WARN +· +· +ready$/m);
  expect(text).toContain('1 failing   2 warnings   0 skipped   3 passing');
  expect(text).toContain('FAIL t3:paired-access  MANAGER_T3_LINK_UNVERIFIED');
  // The same warning on two nodes is printed once, naming both.
  expect(text.match(/PROVIDER_UPSTREAM_UNAVAILABLE/g)).toHaveLength(1);
  expect(text).toContain('    on w1, w2');
  expect(text).toContain('    → Pair it.');
  expect(text).toContain('/r/last-sync.json');
  expect(text).not.toMatch(/\u001b\[/);
});

test('warnings alone are a converged run, and color output adds symbols', () => {
  const text = managerText(
    report([node('w1', [pass('ssh:a'), upstreamDown])]),
    {
      color: true,
    }
  );
  expect(text).toContain('✔ CONVERGED');
  expect(text).toContain('▲');
  expect(text).toMatch(/\u001b\[/);
});

test('summaries split into a leading code and detail', () => {
  expect(splitSummary('SERVICE_NOT_INSTALLED beszel-agent.service')).toEqual({
    code: 'SERVICE_NOT_INSTALLED',
    detail: 'beszel-agent.service',
  });
  expect(splitSummary('Plain sentence.')).toEqual({
    code: '',
    detail: 'Plain sentence.',
  });
});

test('a run with no failures never prints red', () => {
  const text = managerText(
    report([node('w1', [pass('ssh:a'), upstreamDown])]),
    {
      color: true,
    }
  );
  // Red (31) appears nowhere; the zero "failing" count is dimmed.
  expect(text).not.toMatch(/\u001b\[(?:\d+;)*31m/);
  expect(text).toMatch(/\u001b\[2m✖ 0 failing/);
});

test('printed output names only stable public URLs, never tailnet addresses', () => {
  const text = managerText(
    report([
      node('w1', [
        {
          id: 'beszel:hub',
          status: 'fail',
          summary: 'BESZEL_HUB_UNREACHABLE',
          remedy: {
            action:
              'The hub is not at https://mgr.tail0a1b2c.ts.net:8443. Inspect it.',
          },
        },
      ]),
    ])
  );
  expect(text).not.toMatch(/ts\.net/);
  expect(text).toContain('its private tailnet address. Inspect it.');
});
