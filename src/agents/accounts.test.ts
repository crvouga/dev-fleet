import { expect, test } from 'bun:test';
import { accountPrefix, accountsFrom, discoverAccounts } from './accounts';
import {
  forward,
  pinModel,
  RETRY_DELAYS,
  startAccountRelay,
} from './account-relay';
import { pinAccount } from './launch';
import { select } from './registry';

const ids = [
  'claude-opus-5-5',
  'claude-a@example.com/claude-haiku-5-5',
  'claude-a@example.com/claude-sonnet-5-5',
  'claude-b@example.com/claude-sonnet-5-5',
  'codex-a@example.com/gpt-x',
  'antigravity-a@example.com/gemini-3.8-flash',
  'antigravity-a@example.com/gemini-3-flash',
  'devin/claude-opus-5-5',
  'xai-a@example.com/grok',
];

test('the roster is exactly the accounts the proxy lists, per tool', () => {
  const accounts = accountsFrom(ids);
  expect(accounts.map((entry) => `${entry.tool} ${entry.email}`)).toEqual([
    'claude a@example.com',
    'claude b@example.com',
    'codex a@example.com',
    'opencode a@example.com',
  ]);
  // Preferred defaults first, then everything else the account serves.
  expect(accounts[0]!.models).toEqual([
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
  ]);
  expect(accounts[3]).toMatchObject({
    prefix: 'antigravity-a@example.com',
    models: ['gemini-3.8-flash', 'gemini-3-flash'],
  });
  expect(accountsFrom(['claude-opus-5-5'])).toEqual([]);
});

test('an unanswered roster throws; it never reads as no accounts', async () => {
  const answer = (status: number, body: unknown) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;
  expect(
    await discoverAccounts(
      'key',
      answer(200, { data: ids.map((id) => ({ id })) })
    )
  ).toHaveLength(4);
  await expect(discoverAccounts('key', answer(503, {}))).rejects.toThrow();
  await expect(discoverAccounts('key', answer(200, {}))).rejects.toThrow();
});

test('only a real account of a routed tool has a prefix', () => {
  expect(accountPrefix('opencode', 'a@example.com')).toBe(
    'antigravity-a@example.com'
  );
  expect(() => accountPrefix('grok', 'a@example.com')).toThrow();
  expect(() => accountPrefix('claude', 'a/b@example.com')).toThrow();
});

test('the relay pins the model and leaves everything else alone', async () => {
  expect(pinModel('{"model":"m","stream":true}', 'p-a@b.c')).toBe(
    '{"model":"p-a@b.c/m","stream":true}'
  );
  expect(pinModel('{"model":"p-a@b.c/m"}', 'p-a@b.c')).toBe(
    '{"model":"p-a@b.c/m"}'
  );
  expect(pinModel('not json', 'p')).toBe('not json');
  const seen: { url: string; body: string; auth: string | null }[] = [];
  const upstream = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      body: String(init.body),
      auth: new Headers(init.headers).get('authorization'),
    });
    return new Response('data: ok\n\n', {
      headers: {
        'content-encoding': 'gzip',
        'content-type': 'text/event-stream',
      },
    });
  }) as unknown as typeof fetch;
  const response = await forward(
    new Request('http://127.0.0.1:1/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        authorization: 'Bearer k',
        'content-type': 'application/json',
      },
      body: '{"model":"m"}',
    }),
    'https://proxy.example',
    'claude-a@b.c',
    { send: upstream }
  );
  expect(seen).toEqual([
    {
      url: 'https://proxy.example/v1/messages?beta=true',
      body: '{"model":"claude-a@b.c/m"}',
      auth: 'Bearer k',
    },
  ]);
  expect(await response.text()).toBe('data: ok\n\n');
  expect(response.headers.get('content-encoding')).toBeNull();
  const compressed = await forward(
    new Request('http://127.0.0.1:1/v1/responses', {
      method: 'POST',
      headers: { 'content-encoding': 'zstd' },
      body: 'x',
    }),
    'https://proxy.example',
    'p',
    { send: upstream }
  );
  expect(compressed.status).toBe(415);
  expect(seen).toHaveLength(1);
});

test('a route outage is retried until the proxy answers; the agent never sees it', async () => {
  const statuses = [530, 502, 200];
  const waits: number[] = [];
  const bodies: string[] = [];
  const flaky = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const status = statuses.shift()!;
    return new Response(status === 200 ? 'ok' : 'tunnel error', { status });
  }) as unknown as typeof fetch;
  const request = () =>
    new Request('http://127.0.0.1:1/v1/messages', {
      method: 'POST',
      body: '{"model":"m"}',
    });
  const response = await forward(
    request(),
    'https://proxy.example',
    'p-a@b.c',
    {
      send: flaky,
      pause: async (seconds) => void waits.push(seconds),
    }
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('ok');
  expect(waits).toEqual([1, 2]);
  expect(new Set(bodies)).toEqual(new Set(['{"model":"p-a@b.c/m"}']));
  // A real provider error is the proxy's answer: returned at once.
  const rejected = await forward(request(), 'https://proxy.example', 'p', {
    send: (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
    pause: async () => {
      throw new Error('must not wait');
    },
  });
  expect(rejected.status).toBe(429);
  // An outage longer than every delay returns the last answer.
  let calls = 0;
  const down = await forward(request(), 'https://proxy.example', 'p', {
    send: (async () => {
      calls++;
      return new Response('down', { status: 530 });
    }) as unknown as typeof fetch,
    pause: async () => {},
  });
  expect(down.status).toBe(530);
  expect(calls).toBe(RETRY_DELAYS.length + 1);
});

test('a running relay serves a real loopback request', async () => {
  const origin = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) =>
      Response.json({
        got: await request.json(),
        path: new URL(request.url).pathname,
      }),
  });
  const relay = startAccountRelay(
    `http://127.0.0.1:${origin.port}`,
    'codex-a@b.c'
  );
  try {
    const response = await fetch(`${relay.url}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-x' }),
    });
    expect(await response.json()).toEqual({
      got: { model: 'codex-a@b.c/gpt-x' },
      path: '/v1/responses',
    });
  } finally {
    relay.stop();
    void origin.stop(true);
  }
});

test('each tool is pinned its own way, and only to a signed-in account', async () => {
  const discover = async () => accountsFrom(ids);
  const relay = () => ({ url: 'http://127.0.0.1:9', stop: () => {} });
  const claude: NodeJS.ProcessEnv = {};
  await pinAccount(
    claude,
    select('node', 'claude', 'proxy'),
    { account: 'a@example.com', directory: '/tmp/x/claude/proxy' },
    { relay, discover }
  );
  expect(claude['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9');
  expect(claude['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('claude-haiku-5-5');
  const opencode: NodeJS.ProcessEnv = { OPENCODE_CONFIG: '/shared.json' };
  await pinAccount(
    opencode,
    select('node', 'opencode', 'proxy'),
    { account: 'a@example.com', directory: '/tmp/x/opencode/proxy' },
    { relay, discover }
  );
  expect(opencode['OPENCODE_CONFIG']).toBeUndefined();
  const config = JSON.parse(opencode['OPENCODE_CONFIG_CONTENT']!);
  expect(config.enabled_providers).toEqual(['personal_proxy']);
  expect(Object.keys(config.provider.personal_proxy.models)).toEqual([
    'antigravity-a@example.com/gemini-3.8-flash',
    'antigravity-a@example.com/gemini-3-flash',
  ]);
  await expect(
    pinAccount(
      {},
      select('node', 'codex', 'proxy'),
      { account: 'b@example.com', directory: '/tmp/x/codex/proxy' },
      { relay, discover }
    )
  ).rejects.toThrow('not signed in');
});
