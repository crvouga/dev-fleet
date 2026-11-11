import { expect, test } from 'bun:test';
import { workstationChecks } from './workstation-checks';

const result = (ok: boolean) => ({
  ok,
  stdout: 'PRIVATE_SENTINEL',
  stderr: '',
  reason: 'exit' as const,
});

test('the launcher check is read-only and reports no command output', async () => {
  const calls: string[][] = [];
  const present = await workstationChecks('/checkout', async (args) => {
    calls.push(args);
    return result(true);
  });
  expect(present[0]?.status).toBe('pass');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe('test');
  const missing = await workstationChecks('/checkout', async () =>
    result(false)
  );
  expect(missing[0]?.status).toBe('fail');
  expect(JSON.stringify([present, missing])).not.toContain('PRIVATE_SENTINEL');
});
