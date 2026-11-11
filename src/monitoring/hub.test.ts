import { expect, test } from 'bun:test';
import { inspectRoute } from './hub';
const hub = 'https://home.example.ts.net:8443';
test('private hub routing preserves unrelated routes and accepts only its expected proxy', () => {
  expect(inspectRoute('{}', hub)).toBe(false);
  const config = {
    TCP: { '8443': { HTTPS: true } },
    Web: {
      'home.example.ts.net:8443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:8090' } },
      },
    },
  };
  expect(inspectRoute(JSON.stringify(config), hub)).toBe(true);
  expect(
    Array.isArray(
      inspectRoute(
        JSON.stringify({
          ...config,
          AllowFunnel: { 'home.example.ts.net:8443': true },
        }),
        hub
      )
    )
  ).toBe(true);
});
test('raw TCP and another application on the dashboard port require migration', () => {
  expect(
    Array.isArray(
      inspectRoute(
        JSON.stringify({ TCP: { '8443': { TCPForward: 'localhost:9999' } } }),
        hub
      )
    )
  ).toBe(true);
  expect(
    Array.isArray(
      inspectRoute(
        JSON.stringify({
          Web: {
            'home.example.ts.net:8443': {
              Handlers: { '/': { Proxy: 'http://localhost:9000' } },
            },
          },
        }),
        hub
      )
    )
  ).toBe(true);
});
test('a missing tunnel credential is a warning that names the manager Vault session', async () => {
  const { publicEndpointCheck, tunnelToken } = await import('./hub');
  const token = await tunnelToken(async () => ({
    ok: false,
    stdout: '',
    stderr: 'permission denied',
    reason: 'exit',
  }));
  expect(token).toBeNull();
  const check = publicEndpointCheck(false);
  expect(check.status).toBe('warn');
  expect(check.remedy?.action).toContain("manager's Vault session");
  expect(check.remedy?.action).not.toContain('beszel-hub-read');
});
