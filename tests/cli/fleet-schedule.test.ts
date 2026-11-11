import { expect, test } from 'bun:test';
import { managerSchedule } from '../../src/cli/fleet-sync-schedule';
import type { Platform } from '../../src/platform/types';
import type { Runner } from '../../src/types';
const never: Runner = async () => {
  throw new Error('must not execute');
};
const request = {
  revision: 'a'.repeat(40),
  config: '/private/fleet.json',
  authorized: false,
};
test('schedule status is read-only and excludes raw platform output', async () => {
  const platform = {
    scheduledJobStatus: () => ({
      installed: true,
      supported: true,
      detail: 'SECRET',
    }),
  } as unknown as Platform;
  const result = await managerSchedule(
    { ...request, action: 'status' },
    never,
    platform
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.stringify(result.data)).not.toContain('SECRET');
});
test('unattended schedule mutations require explicit authorization', async () => {
  for (const action of ['enable', 'pause', 'resume', 'disable'] as const) {
    const result = await managerSchedule(
      { ...request, action },
      never,
      {} as Platform
    );
    expect(result.exitCode).toBe(1);
  }
});
test('pause removes only the manager schedule through the existing platform adapter', async () => {
  const labels: string[] = [];
  const platform = {
    removeScheduledJob: (label: string) => {
      labels.push(label);
      return { ok: true, detail: 'raw output' };
    },
  } as unknown as Platform;
  const result = await managerSchedule(
    { ...request, action: 'pause', authorized: true },
    never,
    platform
  );
  expect(labels).toEqual(['personal-fleet-sync']);
  expect(result.exitCode).toBe(0);
  expect(JSON.stringify(result.data)).not.toContain('raw output');
});
