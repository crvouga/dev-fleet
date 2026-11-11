import { expect, test } from 'bun:test';
import { convergeable, evaluatePlatform } from './platform';

test('Ubuntu 26.04 on supported CPUs is the accepted worker baseline', () => {
  expect(evaluatePlatform('linux', 'ubuntu\n26.04\nx86_64\n').supported).toBe(
    true
  );
  expect(evaluatePlatform('linux', 'ubuntu\n26.04\naarch64\n').supported).toBe(
    true
  );
  expect(evaluatePlatform('linux', 'ubuntu\n24.04\nx86_64\n')).toMatchObject({
    id: 'ubuntu:release',
    supported: false,
    summary: 'UBUNTU_BASELINE_MISMATCH',
  });
});

test('macOS 14 or newer is best effort; older releases and Linux probes fail', () => {
  expect(evaluatePlatform('macOS', 'macos\n15.2\narm64\n')).toMatchObject({
    id: 'macos:release',
    supported: true,
  });
  expect(evaluatePlatform('macOS', 'macos\n13.6.1\nx86_64\n').supported).toBe(
    false
  );
  expect(evaluatePlatform('macOS', 'ubuntu\n26.04\nx86_64\n').supported).toBe(
    false
  );
  expect(evaluatePlatform('linux', 'macos\n15.2\narm64\n').supported).toBe(
    false
  );
});

test('Windows machines stay declared but are never converged', () => {
  expect(convergeable({ id: 'a', ssh: 'a', os: 'windows' })).toBe(false);
  expect(convergeable({ id: 'a', ssh: 'a', os: 'macOS' })).toBe(true);
  expect(convergeable({ id: 'a', ssh: 'a', os: 'linux' })).toBe(true);
});
