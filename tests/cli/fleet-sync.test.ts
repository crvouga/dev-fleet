import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execute } from '../../src/cli/program';
import { NO_FORWARD_ENV } from '../../src/cli/fleet-sync-forward';

// Never hand off to the real manager over SSH from a test.
beforeAll(() => {
  process.env[NO_FORWARD_ENV] = '1';
});
afterAll(() => {
  delete process.env[NO_FORWARD_ENV];
});

const settings = { workspace: '/no-checkout', config: '/no-roster' };
const revision = 'a'.repeat(40);
test('fleet-sync reports manager scope and enrollment failures without writes', async () => {
  const flat = await execute(
    ['fleet-sync', '--revision', revision, '--dry-run', '--json'],
    settings,
    '0.1.0'
  );
  expect(flat.exitCode).toBe(1);
  expect(flat.data).toMatchObject({
    command: 'fleet-sync',
    applied: false,
    desiredRevision: revision,
  });
});
test('noninteractive sync cannot enroll or authenticate without confirmation', async () => {
  const result = await execute(
    ['fleet-sync', '--revision', revision, '--non-interactive', '--json'],
    settings,
    '0.1.0'
  );
  expect(result.exitCode).toBe(1);
  expect(result.data).toMatchObject({
    applied: false,
    version: 3,
    execution: 'manager-push',
  });
});
test('remote selection requires a roster and never substitutes tailnet discovery', async () => {
  for (const selection of [['--all'], ['--node', 'unknown']]) {
    const result = await execute(
      [
        'fleet-sync',
        ...selection,
        '--revision',
        revision,
        '--dry-run',
        '--json',
      ],
      settings,
      '0.1.0'
    );
    expect(result.exitCode).toBe(1);
  }
});
test('the fleet-sync help page exposes safety flags without a checkout', async () => {
  const result = await execute(['fleet-sync', '--help'], settings, '0.1.0');
  expect(result.exitCode).toBe(0);
  for (const flag of [
    '--dry-run',
    '--node',
    '--all',
    '--apply',
    '--yes',
    '--revision',
  ])
    expect(result.text).toContain(flag);
});
test('stale approved connection bindings fail before source preparation or SSH', async () => {
  const { selected } = await import('../../src/cli/fleet-sync-remote');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'fleet-stale-'));
  try {
    const config = join(root, 'fleet.json');
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 'worker-one',
            ssh: 'worker-one',
            workspace: '/fixture',
            required: [],
          },
        ],
      })
    );
    let calls = 0;
    const outcome = await selected(
      {
        revision,
        apply: true,
        yes: true,
        json: true,
        expectedPlanFingerprint: 'stale-fixture',
      },
      { ...settings, config },
      async () => {
        calls++;
        throw new Error('Must not execute');
      }
    );
    expect(calls).toBe(0);
    expect(JSON.stringify(outcome.data)).toContain('FLEET_PLAN_STALE');
    expect(outcome.exitCode).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
