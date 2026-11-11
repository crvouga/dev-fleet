import { expect, test } from 'bun:test';
import { ensurePublicViewer } from './hub-viewer';

const LOGIN = { identity: 'fleet@example.test', password: 'fleet-password' };
const VIEWER = 'public-viewer@example.com';

function hub(initial: { id: string; role: string } | null, authOk = true) {
  let viewer = initial;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = url.replace('http://hub', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (path.endsWith('/_superusers/auth-with-password'))
      return authOk ? json({ token: 'su' }) : json({}, 400);
    if (method === 'GET') return json({ items: viewer ? [viewer] : [] });
    if (method === 'POST') {
      viewer = { id: 'abcdefghijklmno', role: body.role };
      return json(viewer);
    }
    viewer = { ...viewer!, role: body.role };
    return json(viewer);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test('creates the read-only viewer once, with a random unprinted password', async () => {
  const { fetcher, calls } = hub(null);
  const check = await ensurePublicViewer(LOGIN, fetcher, 'http://hub');
  expect(check.status).toBe('pass');
  const create = calls.find(
    (call) =>
      call.method === 'POST' &&
      call.body &&
      (call.body as { email?: string }).email
  );
  expect(create?.body).toMatchObject({
    email: VIEWER,
    role: 'readonly',
    verified: true,
  });
  expect(JSON.stringify(check)).not.toContain(
    (create!.body as { password: string }).password
  );
});

test('an existing read-only viewer is left alone', async () => {
  const { fetcher, calls } = hub({ id: 'abcdefghijklmno', role: 'readonly' });
  expect((await ensurePublicViewer(LOGIN, fetcher, 'http://hub')).status).toBe(
    'pass'
  );
  expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
});

test('an existing viewer with a stronger role is demoted', async () => {
  const { fetcher, calls } = hub({ id: 'abcdefghijklmno', role: 'admin' });
  expect((await ensurePublicViewer(LOGIN, fetcher, 'http://hub')).status).toBe(
    'pass'
  );
  expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
    role: 'readonly',
  });
});

test('missing or rejected admin credentials warn without leaking details', async () => {
  const none = await ensurePublicViewer(null, fetch, 'http://hub');
  expect(none.summary).toBe('BESZEL_VIEWER_UNPROVISIONED');
  const { fetcher } = hub(null, false);
  const rejected = await ensurePublicViewer(LOGIN, fetcher, 'http://hub');
  expect(rejected.status).toBe('warn');
  expect(JSON.stringify(rejected)).not.toContain(LOGIN.password);
});
