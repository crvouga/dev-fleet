import { expect, test } from 'bun:test';
import { auditUbuntu } from './ubuntu-audit';
import type { Runner } from '../types';

test('Ubuntu audit redacts errors and rejects release/architecture mismatches', async () => {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push(args);
    return {
      ok: true,
      reason: 'exit',
      stderr: 'SECRET',
      stdout:
        args[0] === 'cat'
          ? 'ID=ubuntu\nVERSION_ID="24.04"\n'
          : args[0] === 'dpkg'
            ? 'amd64\n'
            : args[0] === 'dpkg-query'
              ? 'sudo\t1.9.17\nunknown\tSECRET\n'
              : '',
    };
  };
  const audit = await auditUbuntu(run);
  expect(audit.supported).toBe(false);
  expect(audit.packages).toEqual({ sudo: '1.9.17' });
  expect(JSON.stringify(audit)).not.toContain('SECRET');
  expect(
    calls.every(
      (call) =>
        !call.some((arg) =>
          ['install', 'enable', 'restart', 'up', 'login', 'update'].includes(
            arg
          )
        )
    )
  ).toBe(true);
});
