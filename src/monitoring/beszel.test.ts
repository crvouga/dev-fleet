import { describe, expect, test } from 'bun:test';
import { beszelReader, privateHub, verifyBeszel } from './beszel';
const hub = 'https://home.example.ts.net:8443';
const now = Date.parse('2026-11-06T12:00:00Z');
function api(options: { count?: number; status?: string; age?: number } = {}) {
  return async (path: string): Promise<unknown> => {
    if (path.endsWith('/info')) return { v: '0.21.1', key: 'never-output-key' };
    if (path.includes('/systems/'))
      return {
        items: Array.from({ length: options.count ?? 1 }, () => ({
          id: 'abcdefghijklmno',
          status: options.status ?? 'up',
          token: 'never-output-token',
        })),
      };
    return {
      items: [{ created: new Date(now - (options.age ?? 1000)).toISOString() }],
    };
  };
}
describe('Beszel hub evidence', () => {
  test('requires authenticated registration and fresh actual metrics separately', async () => {
    const result = await verifyBeszel(hub, 'devbox', api(), now);
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(result.receivedAt).toBe('2026-11-06T11:59:59.000Z');
    expect(JSON.stringify(result)).not.toContain('never-output');
  });
  test('stopped agent and stale samples cannot pass', async () => {
    const result = await verifyBeszel(
      hub,
      'devbox',
      api({ status: 'down', age: 600000 }),
      now
    );
    expect(
      result.checks.filter((c) => c.status === 'fail').map((c) => c.id)
    ).toEqual(['beszel:connection', 'beszel:freshness']);
  });
  test('missing and duplicate records do not trigger creation', async () => {
    for (const count of [0, 2]) {
      const calls: string[] = [];
      const result = await verifyBeszel(
        hub,
        'devbox',
        async (path) => {
          calls.push(path);
          return api({ count })(path);
        },
        now
      );
      expect(result.checks.at(-1)?.status).toBe('fail');
      expect(calls.length).toBe(2);
    }
  });
  test('outages and secret-bearing errors produce bounded redacted evidence', async () => {
    const result = await verifyBeszel(hub, 'devbox', async () => {
      throw new Error('SECRET');
    });
    expect(result.checks.at(-1)?.summary).toBe('BESZEL_API_UNVERIFIED');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  test('rejects public, insecure, credential-bearing and path URLs', () => {
    for (const value of [
      'https://example.com:8443',
      'http://home.ts.net:8443',
      'https://u:p@home.ts.net:8443',
      `${hub}/path`,
    ])
      expect(() => privateHub(value)).toThrow();
  });
  test('read client refuses redirects and never mints authentication', async () => {
    let init: RequestInit | undefined;
    const reader = beszelReader(hub, 'secret', (async (
      _url: unknown,
      options: RequestInit
    ) => {
      init = options;
      return new Response('{}');
    }) as typeof fetch);
    await reader('/api/beszel/info');
    expect(init?.redirect).toBe('error');
    expect(init?.method).toBeUndefined();
  });
});
