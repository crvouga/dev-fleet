import { expect, test } from 'bun:test';
import { serviceState } from './worker-host-checks';

test('a failed service check names what was observed', () => {
  expect(
    serviceState(
      'beszel-agent',
      'ActiveState=inactive\nUnitFileState=\nRestart=no\n'
    )
  ).toBe(
    'SERVICE_NOT_INSTALLED beszel-agent.service (inactive, unit file missing, restart no)'
  );
  expect(
    serviceState(
      'beszel-agent',
      'ActiveState=failed\nUnitFileState=enabled\nRestart=always\n'
    )
  ).toStartWith('SERVICE_NOT_RUNNING');
});
