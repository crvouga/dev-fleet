import { afterEach, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { automaticRepairs, repairPlan } from './repair-plan';
import { recipe } from './repair-catalog';
import { repairWorkspace, validRepairs } from './repair-runner';
import { fingerprint } from './fingerprint';
import { probe } from './probe';
import { bundleProbe, inspectRemote } from './transport';
import { runCommand } from './runner';
import { failure, gitRunner, NODE, success, workspace } from './test-fixtures';
import type { Check } from './types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await workspace();
  roots.push(root);
  return root;
}

test('every nonpassing check has a repair or operator step; logins, Docker, trust and unknown checks never auto-execute', async () => {
  const root = await fixture();
  const snapshot = await probe(root, [], gitRunner);
  const checks: Check[] = [
    { id: 'tool:node', status: 'fail', summary: 'wrong version' },
    { id: 'dependencies', status: 'warn', summary: 'stale' },
    { id: 'auth:codex', status: 'fail', summary: 'missing' },
    { id: 'auth:github', status: 'fail', summary: 'missing' },
    { id: 'tool:github-auth', status: 'warn', summary: 'missing' },
    { id: 'tool:docker-engine', status: 'fail', summary: 'not running' },
    { id: 'workstation:path', status: 'fail', summary: 'not linked' },
    { id: 't3:end-to-end', status: 'skip', summary: 'unverified' },
    {
      id: 'ssh:host-key',
      status: 'fail',
      summary: 'unknown',
      remedy: { action: 'Verify independently', command: 'DO-NOT-EXECUTE' },
    },
    { id: 'future:unknown', status: 'warn', summary: 'needs investigation' },
    { id: 'auth:aws', status: 'pass', summary: 'signed in' },
  ];
  const steps = repairPlan(
    [{ node: 'local', snapshot, checks }],
    [{ name: 'local', root }]
  );
  expect(steps.flatMap((step) => step.checks).sort()).toEqual(
    checks
      .filter((check) => check.status !== 'pass')
      .map((check) => check.id)
      .sort()
  );
  expect(steps.find((step) => step.id === 'workspace')?.checks).toHaveLength(2);
  expect(steps.filter((step) => step.automatic).map((step) => step.id)).toEqual(
    ['workspace', 'workstation']
  );
  expect(steps.find((step) => step.id === 'login:github')?.checks).toHaveLength(
    2
  );
  expect(JSON.stringify(steps.map((step) => step.commands))).not.toContain(
    'DO-NOT-EXECUTE'
  );
  const unreachable = repairPlan([{ node: 'unreachable', checks }], []);
  expect(unreachable.every((step) => !step.eligible)).toBe(true);
});

test('owner repairs are ordered, use fixed commands and stop later repairs after failure without leaking output', async () => {
  const root = await fixture();
  const calls: string[][] = [];
  const checks = await repairWorkspace(
    root,
    ['providers', 'workstation', 'workspace'],
    async (command) => {
      calls.push(command);
      if (command[0] === 'mise') return failure('private-secret');
      return gitRunner(command);
    }
  );
  expect(checks[0]?.status).toBe('fail');
  expect(calls.filter((command) => command[0] !== 'git')).toEqual([
    recipe('workspace').commands[0]!,
  ]);
  expect(JSON.stringify(checks)).not.toContain('private-secret');
});

test('provider repair delegates to workstation and never runs logins, sudo, key copies or provider API mutations', async () => {
  const root = await fixture();
  const calls: string[][] = [];
  const checks = await repairWorkspace(root, ['providers'], async (command) => {
    calls.push(command);
    return gitRunner(command);
  });
  expect(checks).toMatchObject([{ id: 'repair:providers', status: 'pass' }]);
  expect(calls.filter((command) => command[0] !== 'git')).toEqual([
    recipe('providers').commands[0]!,
  ]);
  expect(calls.flat()).not.toContain('login');
  expect(calls.flat()).not.toContain('sudo');
  expect(calls.flat()).not.toContain('scp');
  expect(calls.flat()).not.toContain('rsync');
});

test('stale checkout inputs and unsupported actions fail before running any owner mutation', async () => {
  const root = await fixture();
  const expected = await fingerprint(root, gitRunner);
  await writeFile(join(root, 'mise.lock'), 'changed');
  const calls: string[][] = [];
  const result = await repairWorkspace(
    root,
    ['workstation'],
    async (command) => {
      calls.push(command);
      return gitRunner(command);
    },
    expected
  );
  expect(result[0]?.id).toBe('repair:inputs');
  expect(result[0]?.status).toBe('fail');
  expect(calls.every((command) => command[0] === 'git')).toBe(true);
  for (const input of [
    [],
    ['login:codex'],
    ['workspace', 'workspace'],
    ['rm -rf'],
    'workspace',
  ])
    expect(validRepairs(input)).toBe(false);
});

test('streamed remote protocol requires explicit apply, valid fingerprints and allowlisted repairs before any mutation', async () => {
  const root = await fixture();
  const source = await bundleProbe();
  const expected = await fingerprint(root, gitRunner);
  for (const request of [
    { apply: false, repairs: ['workspace'], expected },
    { apply: true, repairs: ['login:codex'], expected },
    { apply: true, repairs: ['workspace'], expected: null },
  ]) {
    const encoded = Buffer.from(
      JSON.stringify({
        action: 'repair',
        node: { ...NODE, workspace: root },
        ...request,
      })
    ).toString('base64');
    const result = await runCommand(
      ['node', '--input-type=module', '-', encoded],
      { cwd: root, input: source }
    );
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      error: expect.any(String),
    });
  }
});

test('automatic actions keep prerequisite order and empty remote execution receipts fail closed', async () => {
  const root = await fixture();
  const snapshot = await probe(root, [], gitRunner);
  const steps = repairPlan(
    [
      {
        node: 'local',
        snapshot,
        checks: [
          { id: 'workstation:path', status: 'fail', summary: 'missing' },
          { id: 'tool:node', status: 'fail', summary: 'missing' },
        ],
      },
    ],
    [{ name: 'local', root }]
  );
  expect(automaticRepairs(steps, 'local').map((step) => step.id)).toEqual([
    'workspace',
    'workstation',
  ]);
  const result = await inspectRemote(
    NODE,
    {
      action: 'repair',
      source: 'fixture',
      timeoutMs: 1000,
      repairs: ['providers'],
      expected: snapshot.fingerprint,
    },
    async () => success('{"version":1,"checks":[]}')
  );
  expect(result.checks).toMatchObject([{ id: 'ssh:protocol', status: 'fail' }]);
});
