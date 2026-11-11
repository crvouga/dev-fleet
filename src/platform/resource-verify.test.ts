import { expect, test } from 'bun:test';
import { verifyResourceSafety } from './resource-verify';
import type { Runner } from '../types';

const result = (stdout: string, ok = true) => ({
  ok,
  stdout,
  stderr: '',
  reason: 'exit' as const,
});
const healthy: Runner = async (args) => {
  if (args[1] === 'is-active') return result('active\n');
  if (args.includes('user.slice')) return result('MemoryMax=29720510464\n');
  if (args.includes('-.slice')) return result('ManagedOOMSwap=kill\n');
  if (args[0] === 'test') return result('');
  if (args[0] === 'cat')
    return result(
      'Filename Type Size Used Priority\n/swap.img file 8388604 0 -2\n'
    );
  if (args[0] === 'df') return result('Avail\n107374182400\n');
  if (args[0] === 'sh') return result('');
  throw new Error('Unexpected command ' + args.join(' '));
};
type Result = ReturnType<typeof result>;
const verify = (override: (args: string[]) => Result | undefined) =>
  verifyResourceSafety(
    '/home/fixture',
    async (args, options) => override(args) ?? healthy(args, options)
  );

test('a guarded node with headroom passes', async () => {
  const checks = await verifyResourceSafety('/home/fixture', healthy);
  expect(checks[0]?.status).toBe('pass');
});
test('a stopped disk guard fails', async () => {
  const checks = await verify((args) =>
    args.at(-1) === 'personal-fleet-disk-guard.service'
      ? result('failed\n', false)
      : undefined
  );
  expect(checks[0]?.summary).toBe('RESOURCE_GUARD_INACTIVE');
});
test('uncapped user memory fails', async () => {
  const checks = await verify((args) =>
    args.includes('user.slice') ? result('MemoryMax=infinity\n') : undefined
  );
  expect(checks[0]?.summary).toBe('MEMORY_RESERVE_MISSING');
});
test('no swap fails', async () => {
  const checks = await verify((args) =>
    args[0] === 'cat' ? result('Filename Type Size Used Priority\n') : undefined
  );
  expect(checks[0]?.summary).toBe('SWAP_MISSING');
});
test('free space under the guard floor fails even when every guard runs', async () => {
  const checks = await verify((args) =>
    args[0] === 'df' ? result('Avail\n2147483648\n') : undefined
  );
  expect(checks[0]?.summary).toBe('DISK_FREE_BELOW_FLOOR');
});
test('an exhausted /tmp quota fails even when the filesystem reports free space', async () => {
  const checks = await verify((args) =>
    args[0] === 'sh' ? result('', false) : undefined
  );
  expect(checks[0]?.summary).toBe('TMP_QUOTA_EXHAUSTED');
});
