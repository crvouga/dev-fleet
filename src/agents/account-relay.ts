/** Pins one agent process to one provider account. The proxy routes a model
 * named `<prefix>/<model>` only to the credential that owns the prefix, but
 * agents send whichever model the user picked. This loopback relay lives only
 * as long as the agent it was started for: it adds the prefix to each request
 * and forwards everything else (credentials, streaming) unchanged.
 */
export function startAccountRelay(
  endpoint: string,
  prefix: string
): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Model streams are idle for as long as a model thinks.
    idleTimeout: 0,
    fetch: (request) => forward(request, endpoint, prefix),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => void server.stop(true),
  };
}

type RelayOptions = {
  send?: typeof fetch;
  pause?: (seconds: number) => Promise<void>;
};
const sleep = (seconds: number) =>
  new Promise<void>((done) => setTimeout(done, seconds * 1000));

export async function forward(
  request: Request,
  endpoint: string,
  prefix: string,
  { send = fetch, pause = sleep }: RelayOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // fetch sets these for the upstream request and decodes its response.
  for (const name of ['host', 'content-length', 'accept-encoding'])
    headers.delete(name);
  let body: string | undefined;
  if (request.body) {
    // An unreadable body could not be pinned; never forward it to the pool.
    if (headers.has('content-encoding'))
      return new Response('The account relay needs an uncompressed request.', {
        status: 415,
      });
    body = pinModel(await request.text(), prefix);
  }
  const attempt = () =>
    send(endpoint + url.pathname + url.search, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
      signal: request.signal,
    });
  const upstream = await reachProxy(attempt, request.signal, pause);
  if (!upstream)
    return new Response('The CLI proxy is unreachable.', { status: 502 });
  const answered = new Headers(upstream.headers);
  answered.delete('content-encoding');
  answered.delete('content-length');
  return new Response(upstream.body, {
    status: upstream.status,
    headers: answered,
  });
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
  pause: (seconds: number) => Promise<void>
): Promise<Response | null> {
  for (let tries = 0; ; tries++) {
    const delay = RETRY_DELAYS[tries];
    const response = await attempt().catch(() => null);
    if (response && !routeDown(response.status)) return response;
    if (delay === undefined || signal.aborted) return response;
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
