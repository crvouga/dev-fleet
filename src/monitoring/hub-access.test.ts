import { expect, test } from 'bun:test';
import { fleetIdentity, failure, fleetCredentials } from './hub-access';

test('the generated password maps to the fixed fleet account; legacy JSON still works', () => {
  expect(fleetCredentials('generated-secret-value\n')).toEqual({
    identity: fleetIdentity(),
    password: 'generated-secret-value',
  });
  expect(
    fleetCredentials('{"identity":"ops@example.test","password":"p"}')
  ).toEqual({ identity: 'ops@example.test', password: 'p' });
  for (const invalid of ['', '   ', '{"identity":"x"}', '{not json']) {
    expect(() => fleetCredentials(invalid)).toThrow('BESZEL_ACCOUNT_INVALID');
  }
});

test('a rejected password login names the missing hub account', () => {
  const login = '/api/collections/users/auth-with-password';
  expect(failure(400, login)).toBe('BESZEL_ACCOUNT_REQUIRED');
  expect(failure(400, '/api/collections/systems/records')).toBe(
    'BESZEL_API_UNAVAILABLE'
  );
  expect(failure(403, login)).toBe('BESZEL_AUTH_REQUIRED');
  expect(failure(503, login)).toBe('BESZEL_API_UNAVAILABLE');
});
