import { expect, test } from 'bun:test';
import { makeReport, mapBounded, reportExitCode } from './report';
import { decodeSnapshot } from './protocol';
import { HEAD } from './test-fixtures';
import type { NodeReport } from './types';

test('reports retain warning/skip coverage and stable exit behavior', () => {
  const nodes: NodeReport[] = [
    {
      node: 'first',
      checks: [
        { id: 'one', status: 'pass', summary: 'passed' },
        { id: 'two', status: 'warn', summary: 'unverified' },
        { id: 'three', status: 'skip', summary: 'not run' },
      ],
    },
  ];
  const report = makeReport('doctor', nodes);
  expect(report.summary).toEqual({ pass: 1, warn: 1, skip: 1, fail: 0 });
  expect(reportExitCode(report, false)).toBe(0);
  expect(reportExitCode(report, true)).toBe(1);
  expect(
    reportExitCode(
      makeReport('doctor', [
        {
          node: 'bad',
          checks: [{ id: 'broken', status: 'fail', summary: 'failed' }],
        },
      ]),
      false
    )
  ).toBe(1);
});

test('parallel probes preserve order and respect the concurrency bound', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapBounded(
    [5, 4, 3, 2, 1],
    async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Bun.sleep(value);
      active -= 1;
      return value * 2;
    },
    2
  );
  expect(result).toEqual([10, 8, 6, 4, 2]);
  expect(maximum).toBe(2);
});

test('protocol strips unknown payload fields rather than echoing subprocess documents', () => {
  const raw = {
    version: 1,
    platform: 'linux',
    token: 'never-print-this',
    fingerprint: { head: HEAD, files: {}, password: 'never-print-this' },
    checks: [
      {
        id: 'example',
        status: 'pass',
        summary: 'safe',
        private: 'never-print-this',
        remedy: { action: 'safe', token: 'never-print-this' },
      },
    ],
  };
  const decoded = decodeSnapshot(JSON.stringify(raw));
  expect(decoded?.version).toBe(1);
  expect(JSON.stringify(decoded)).not.toContain('never-print-this');
});
