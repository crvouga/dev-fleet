import {
  AccountSelector,
  accountRefused,
  retryAfter,
} from '../accounts/selection';

/** Pins one agent process to one provider account. The proxy routes a model
 * named `<prefix>/<model>` only to the credential that owns the prefix, but
 * agents send whichever model the user picked. This loopback relay lives only
 * as long as the agent it was started for: it adds the prefix to each request
 * and forwards everything else (credentials, streaming) unchanged.
 *
 * With an empty prefix it pins nothing: every launch goes through a relay, so
 * every launch rides out a proxy restart the same way. `selector` then picks
 * the account of each request by the fleet's selection policy.
 */
export function startAccountRelay(
  endpoint: string,
  prefix: string,
  options: Pick<RelayOptions, 'selector' | 'alternatives'> = {}
): { url: string; stop: () => void } {
  const pinned =
    prefix && !options.selector
      ? new AccountSelector([prefix], { strategy: 'fill-first' })
      : options.selector;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Model streams are idle for as long as a model thinks.
    idleTimeout: 0,
    fetch: (request) =>
      forward(request, endpoint, prefix, {
        ...options,
        ...(pinned ? { selector: pinned } : {}),
      }),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => void server.stop(true),
  };
}

type RelayOptions = {
  send?: typeof fetch;
  pause?: (seconds: number) => Promise<void>;
  /** Unpinned: the accounts to try in turn. Pinned: remembers cooldowns. */
  selector?: AccountSelector;
  /** Pinned: the other instances of the provider, named in its error. */
  alternatives?: string[];
  now?: () => number;
};
const sleep = (seconds: number) =>
  new Promise<void>((done) => setTimeout(done, seconds * 1000));

export async function forward(
  request: Request,
  endpoint: string,
  prefix: string,
  options: RelayOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // fetch sets these for the upstream request and decodes its response.
  for (const name of ['host', 'content-length', 'accept-encoding'])
    headers.delete(name);
  // An unreadable body could not be pinned; never forward it to the pool.
  if (request.body && headers.has('content-encoding'))
    return new Response('The account relay needs an uncompressed request.', {
      status: 415,
    });
  const raw = request.body ? await request.text() : undefined;
  const reach = reacher(
    request,
    headers,
    endpoint + url.pathname + url.search,
    options
  );
  const { selector } = options;
  const reached =
    !prefix && selector && raw !== undefined
      ? await failOver(selector, raw, reach)
      : await pinnedReach(prefix, raw, reach, options);
  if (reached instanceof Response) return reached;
  return answer(reached);
}

/** Sends one body to the proxy, retrying while the route is down. */
function reacher(
  request: Request,
  headers: Headers,
  target: string,
  { send = fetch, pause = sleep, now = Date.now }: RelayOptions
): (body: string | undefined) => Promise<Reached> {
  return (body) =>
    reachProxy(
      () => send(target, upstreamInit(request, headers, body)),
      request.signal,
      pause,
      now
    );
}

/** The proxy's answer, decoded, or the distinct "unreachable" error. */
function answer(reached: Reached): Response {
  const upstream = reached.response;
  if (!upstream) return unreachable(reached.since);
  const answered = new Headers(upstream.headers);
  answered.delete('content-encoding');
  answered.delete('content-length');
  return new Response(upstream.body, {
    status: upstream.status,
    headers: answered,
  });
}

/** A pinned account (or no pinning at all). A pinned account the provider
 * limited answers at once, until its cooldown clears, with the time and the
 * other instances of its provider.
 */
async function pinnedReach(
  prefix: string,
  raw: string | undefined,
  reach: (body: string | undefined) => Promise<Reached>,
  { selector, alternatives = [] }: RelayOptions
): Promise<Reached | Response> {
  const cooling = prefix && selector ? selector.coolingUntil(prefix) : null;
  if (cooling !== null) return coolingDown(cooling, alternatives);
  const reached = await reach(
    raw !== undefined && prefix ? pinModel(raw, prefix) : raw
  );
  if (!prefix || !selector || reached.response?.status !== 429) return reached;
  selector.limited(prefix, retryAfter(reached.response.headers));
  await reached.response.body?.cancel().catch(() => undefined);
  return coolingDown(selector.coolingUntil(prefix)!, alternatives);
}

type Reached = { response: Response | null; since: number };

function upstreamInit(
  request: Request,
  headers: Headers,
  body: string | undefined
): RequestInit {
  return {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'error',
    signal: request.signal,
  };
}

/** An unpinned request goes to the first usable account by the fleet's
 * policy; a quota or authentication refusal sends it on to the next. With
 * every account cooling down, the proxy's own pool serves it.
 */
async function failOver(
  selector: AccountSelector,
  raw: string,
  reach: (body: string | undefined) => Promise<Reached>
): Promise<Reached> {
  const candidates = selector.candidates();
  if (candidates.length === 0) return reach(raw);
  let reached!: Reached;
  for (const [position, candidate] of candidates.entries()) {
    reached = await reach(pinModel(raw, candidate));
    const status = reached.response?.status;
    if (status === undefined || !accountRefused(status)) return reached;
    selector.limited(candidate, retryAfter(reached.response!.headers));
    if (position < candidates.length - 1)
      await reached.response!.body?.cancel().catch(() => undefined);
  }
  return reached;
}

/** One error both Anthropic and OpenAI clients show as a message. */
function agentError(
  status: number,
  type: string,
  message: string,
  retry: number
) {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(Math.max(1, Math.ceil(retry))),
      },
    }
  );
}

function coolingDown(until: number, alternatives: string[]): Response {
  const others = alternatives.length
    ? ` Pick another instance of this provider in T3: ${alternatives.join(', ')}.`
    : '';
  return agentError(
    429,
    'rate_limit_error',
    `This account is cooling down until ${new Date(until).toISOString()}.${others}`,
    (until - Date.now()) / 1000
  );
}

/** The proxy did not answer within the retry window: a distinct, retryable
 * error that says since when, never a provider's error.
 */
function unreachable(since: number): Response {
  return agentError(
    503,
    'proxy_unreachable',
    `The CLI proxy has been unreachable since ${new Date(since).toISOString()}. This is retryable; nothing is wrong with the account.`,
    30
  );
}

/** Seconds to wait before each further attempt (about a minute in total). */
export const RETRY_DELAYS = [1, 2, 4, 8, 15, 30];
/** The route to the proxy answered instead of the proxy: its connector or the
 * proxy itself is restarting. 502-504 from a gateway, 520-530 from Cloudflare.
 */
const routeDown = (status: number) =>
  (status >= 502 && status <= 504) || (status >= 520 && status <= 530);

/** A brief outage of the route must not end an agent's turn: nothing has been
 * sent to the agent yet, so the same request is simply tried again until the
 * proxy answers or the delays run out. The last answer is returned as it is.
 */
async function reachProxy(
  attempt: () => Promise<Response>,
  signal: AbortSignal,
  pause: (seconds: number) => Promise<void>,
  now: () => number
): Promise<Reached> {
  const since = now();
  for (let tries = 0; ; tries++) {
    const delay = RETRY_DELAYS[tries];
    const response = await attempt().catch(() => null);
    if (response && !routeDown(response.status)) return { response, since };
    if (delay === undefined || signal.aborted) return { response, since };
    await response?.body?.cancel().catch(() => undefined);
    await pause(delay);
  }
}

/** The JSON request with its model routed to the account; other bodies as-is. */
export function pinModel(text: string, prefix: string): string {
  try {
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const model = (payload as { model?: unknown }).model;
      if (typeof model === 'string' && !model.startsWith(`${prefix}/`))
        return JSON.stringify({ ...payload, model: `${prefix}/${model}` });
    }
  } catch {
    /* Not JSON: nothing to route. */
  }
  return text;
}
