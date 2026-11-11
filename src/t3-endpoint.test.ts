import { expect, test } from 'bun:test';
import { verifyT3Endpoint } from './t3-endpoint';
import type { FleetNode, Runner } from './types';
const node: FleetNode = {
  id: 'fixture',
  ssh: 'fixture',
  workspace: '/unused',
  required: [],
  tailscaleId: 'peer',
};
const run: Runner = async () => ({
  ok: true,
  stdout: JSON.stringify({
    BackendState: 'Running',
    Self: {
      ID: 'manager',
      DNSName: 'manager.fixture.ts.net.',
      HostName: 'manager',
      OS: 'linux',
      Online: true,
      TailscaleIPs: ['100.64.0.1'],
    },
    Peer: {
      peer: {
        ID: 'peer',
        DNSName: 'dev.fixture.ts.net.',
        HostName: 'dev',
        OS: 'linux',
        Online: true,
        TailscaleIPs: ['100.64.0.2'],
      },
    },
  }),
  stderr: '',
  reason: 'exit',
});
test('manager HTTP evidence remains explicitly separate from paired acceptance', async () => {
  const request = async (url: string, options: RequestInit) => {
    expect(url).toBe('https://dev.fixture.ts.net');
    expect(options.redirect).toBe('manual');
    return new Response('fixture');
  };
  const checks = await verifyT3Endpoint(node, run, request);
  expect(checks[0]?.status).toBe('pass');
  expect(checks[0]?.summary).toContain('tool execution remain unverified');
});
test('redirects and TLS errors fail without printing response data', async () => {
  for (const request of [
    async () => new Response('PRIVATE_SENTINEL', { status: 302 }),
    async () => {
      throw new Error('PRIVATE_SENTINEL');
    },
  ]) {
    const checks = await verifyT3Endpoint(node, run, request);
    expect(checks[0]?.status).toBe('fail');
    expect(JSON.stringify(checks)).not.toContain('PRIVATE_SENTINEL');
  }
});
