import { expect, test } from 'bun:test';
import definition from '../examples/fleet.json';
import { enrolledRoster, parseDefinition } from './definition';
import { parseWorkerPolicy } from './worker-policy';
import { workerAccessChecks } from './worker-access-checks';
import { powerRecoveryCheck } from './power-recovery';
import { verifyT3Linked } from './t3-linked-check';
import { success, failure, NODE } from './test-fixtures';

test('canonical worker requirements cannot be waived by private connection overrides', () => {
  const policy = parseDefinition(definition);
  const machine = definition.workers[0]!;
  const roster = enrolledRoster(policy, {
    version: 1,
    nodes: [{ ...NODE, id: machine.id, ssh: machine.ssh, required: [] }],
  });
  expect(roster.nodes[0]!.required).toEqual(
    policy.worker!.requiredCapabilities
  );
  for (const missing of definition.worker.requiredCapabilities)
    expect(() =>
      parseWorkerPolicy({
        ...definition.worker,
        requiredCapabilities: definition.worker.requiredCapabilities.filter(
          (capability) => capability !== missing
        ),
      })
    ).toThrow();
});
test('gateway health is authenticated without inference, argv credentials, or raw auth output', async () => {
  const token = 'PRIVATE_SENTINEL_TOKEN';
  const checks = await workerAccessChecks(async (args, options) => {
    expect(JSON.stringify(args)).not.toContain(token);
    if (args[0] === 'gh') return success('example-user');
    if (args[0] === 'vault')
      return args.includes('lookup')
        ? success('{"data":{"renewable":true,"period":86400,"ttl":80000}}')
        : success(token);
    expect(options?.input).toBe(`Authorization: Bearer ${token}\n`);
    return success('{"data":[{"id":"model"}]}');
  });
  expect(checks.every((check) => check.status === 'pass')).toBe(true);
  expect(JSON.stringify(checks)).not.toContain(token);
});
test('firmware recovery never passes without observed supported configuration', async () => {
  expect((await powerRecoveryCheck(async () => failure())).status).toBe('skip');
  expect(
    (
      await powerRecoveryCheck(async () =>
        success(
          '{"BiosSettings":[{"Name":"AfterPowerLoss","CurrentValue":"Power On"}]}'
        )
      )
    ).status
  ).toBe('pass');
});
test('T3 access requires matching live environment identity and unexpired native pairing', async () => {
  const now = Date.now();
  for (const match of [true, false]) {
    const check = await verifyT3Linked(
      NODE,
      async (args) =>
        args[0] === 'ssh'
          ? success('{"environmentId":"expected"}')
          : success(
              JSON.stringify([
                {
                  environmentId: match ? 'expected' : 'other',
                  status: 'reachable',
                  expiresAt: new Date(now + 30 * 86400000).toISOString(),
                },
              ])
            ),
      { now: () => now }
    );
    expect(check.status).toBe(match ? 'pass' : 'fail');
  }
});
test('an explicitly enrolled T3 environment is checked through native authenticated links without SSH', async () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const check = await verifyT3Linked(
    { ...NODE, t3EnvironmentId: id },
    async (args) => {
      expect(args[0]).toBe('t3');
      return success(
        JSON.stringify([
          {
            environmentId: id,
            status: 'reachable',
            expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          },
        ])
      );
    }
  );
  expect(check.status).toBe('pass');
});

test('after a restart in this sync, the link check waits for the reconnect', async () => {
  let listings = 0;
  let clock = 0;
  const check = await verifyT3Linked(
    { ...NODE, t3EnvironmentId: 'env' },
    async () => {
      listings++;
      return success(
        JSON.stringify([
          {
            environmentId: 'env',
            status: listings < 3 ? 'unreachable' : 'reachable',
            expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          },
        ])
      );
    },
    {
      now: () => Date.now() + clock,
      reconnectMs: 60_000,
      pause: async () => {
        clock += 10_000;
      },
    }
  );
  expect(check.status).toBe('pass');
  expect(listings).toBe(3);
});
