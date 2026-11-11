import { expect, test } from 'bun:test';
import { providerHttpFailure, providerFailureCode } from './provider-errors';
import { inferenceFailure } from './fleet-verify';
test('provider rejection distinguishes auth, quota, upstream and protocol failures', () => {
  for (const [status, code] of [
    [401, 'PROVIDER_AUTH_REJECTED'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [503, 'PROVIDER_UPSTREAM_UNAVAILABLE'],
    [404, 'PROVIDER_PROTOCOL_REJECTED'],
  ] as const)
    expect(providerFailureCode(providerHttpFailure(status))).toBe(code);
});
test('unexpected private errors never become diagnostic codes', () => {
  expect(providerFailureCode(new Error('PRIVATE_SENTINEL'))).toBe(
    'PROVIDER_ROUTE_UNVERIFIED'
  );
  expect(providerFailureCode(new TypeError('PRIVATE_SENTINEL'))).toBe(
    'PROVIDER_NETWORK_UNVERIFIED'
  );
  expect(providerFailureCode(new Error('PROVIDER_STREAM_INCOMPLETE'))).toBe(
    'PROVIDER_STREAM_INCOMPLETE'
  );
});

test('provider account conditions warn; gateway and credential failures fail', () => {
  expect(inferenceFailure('codex', 'PROVIDER_RATE_LIMITED').status).toBe(
    'pass'
  );
  for (const code of [
    'PROVIDER_UPSTREAM_UNAVAILABLE',
    'PROVIDER_MODEL_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
  ])
    expect(inferenceFailure('codex', code).status).toBe('warn');
  for (const code of ['PROVIDER_AUTH_REJECTED', 'PROVIDER_NETWORK_UNVERIFIED'])
    expect(inferenceFailure('codex', code).status).toBe('fail');
});
