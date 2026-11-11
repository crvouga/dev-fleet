import { expect, test } from 'bun:test';
import { diagnostic } from './diagnostics';

test('authentication failures are actionable and never blindly retryable', () => {
  const result = diagnostic('devbox', {
    id: 'provider:claude:inference',
    status: 'fail',
    summary: 'PROVIDER_AUTH_REQUIRED',
    remedy: { action: 'Renew existing authorized access.' },
  });
  expect(result).toMatchObject({
    node: 'devbox',
    phase: 'provider',
    code: 'PROVIDER_AUTH_REQUIRED',
    scope: 'node',
    retryable: false,
    actionRequired: true,
    durationMs: null,
  });
  expect(result.remedy.owner).toBe('dev-fleet');
});
test('stale metrics can be retried, but unknown probe origin is not fabricated', () => {
  expect(
    diagnostic('devbox', {
      id: 'beszel:freshness',
      status: 'fail',
      summary: 'BESZEL_METRICS_STALE',
    })
  ).toMatchObject({ scope: 'manager', retryable: true });
  expect(
    diagnostic('devbox', {
      id: 't3:end-to-end',
      status: 'skip',
      summary: 'REQUIRED_ACCEPTANCE_UNVERIFIED',
    })
  ).toMatchObject({ scope: 'unverified', actionRequired: true });
});
test('measured phase duration survives redaction while unknown fields do not', async () => {
  const { cleanCheck, validCheck } = await import('./protocol');
  const check = {
    id: 'ubuntu:baseline',
    status: 'pass' as const,
    summary: 'Observed',
    phaseDurationMs: 1234,
    privateOutput: 'PRIVATE_SENTINEL',
  };
  expect(validCheck(check)).toBe(true);
  expect(diagnostic('fixture', cleanCheck(check)).durationMs).toBe(1234);
  expect(JSON.stringify(cleanCheck(check))).not.toContain('PRIVATE_SENTINEL');
  for (const phaseDurationMs of [-1, Infinity, '1234', 0.5])
    expect(validCheck({ ...check, phaseDurationMs })).toBe(false);
});
