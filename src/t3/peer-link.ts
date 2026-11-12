import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { record } from '../config';
import { sshArgs } from '../ssh';
import { observedIdentity } from '../t3-linked-check';
import { discoverTailnet } from '../tailscale';
import type { Check, FleetNode, Runner } from '../types';

/** Pairing the manager's T3 with a worker's T3 environment, with no person.
 *
 * A pairing code is a one-time secret, so it never enters a command line,
 * a report or a log. The worker mints it (`t3 auth pairing create --json`
 * over the SSH session the manager already has), and its stdout is read in
 * memory. The manager's T3 receives it in the body of one request to its
 * own server on loopback: the `peerLinks.link` call of its WebSocket API,
 * which the T3 Settings (Connections) use, authorized by a session issued
 * for this one call and revoked after it. `t3 environment link` takes the
 * code only as `--pairing-code`, so it is not used.
 */

/** What the manager's T3 is asked to do: link the environment at `url`. */
export interface LinkRequest {
  url: string;
  pairingCode: string;
  /** The environment the worker answered as over SSH: T3 refuses an
   * address that answers as another one. */
  expectedEnvironmentId: string;
}

export type LinkOutcome =
  | { environmentId: string }
  /** Why T3 refused, as its own reason (`pairing_rejected`, `unreachable`,
   * `disabled`, …), or `unavailable` when the manager's T3 did not answer. */
  | { refused: string };

/** The manager's own T3. */
export interface ManagerT3 {
  link(request: LinkRequest): Promise<LinkOutcome>;
}

/** The two requests to the manager's T3 server, injected by scenarios. */
export interface T3Transport {
  /** POSTs to the server with the session as a bearer token; the JSON body. */
  post(url: string, bearer: string): Promise<unknown>;
  /** Sends one message on a WebSocket and answers with the first message
   * that ends request `id`. */
  call(url: string, message: object, id: string): Promise<unknown>;
}

/** The access the manager's agents get on the worker: T3's default. */
const ACCESS = 'approval-required';
/** Scopes of the session that makes the call, and how long it lives at most. */
const SESSION = [
  '--ttl',
  '2m',
  '--scope',
  'access:write',
  '--label',
  'dev-fleet pairing',
];
/** The WebSocket protocol of the pinned T3 server. */
const ORCHESTRATION_PROTOCOL = '2';
const CODE = /^[A-Za-z0-9_-]{6,128}$/;
const ENVIRONMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The manager's T3, reached through its local server. */
export function managerT3(
  run: Runner,
  options: {
    home?: string;
    transport?: T3Transport;
    read?: (path: string) => Promise<string>;
  } = {}
): ManagerT3 {
  const home = resolve(
    options.home ?? process.env['T3CODE_HOME'] ?? join(homedir(), '.t3')
  );
  const transport = options.transport ?? webTransport;
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'));
  return {
    async link(request) {
      const origin = await loopbackOrigin(read, home);
      if (!origin) return { refused: 'unavailable' };
      const issued = await run(
        ['t3', 'auth', 'session', 'issue', '--json', ...SESSION],
        { timeoutMs: 30_000 }
      );
      const session = parseSession(issued.ok ? issued.stdout : '');
      if (!session) return { refused: 'unavailable' };
      try {
        const ticket = await transport.post(
          `${origin}/api/auth/websocket-ticket/rpc`,
          session.token
        );
        if (!record(ticket) || typeof ticket['ticket'] !== 'string')
          return { refused: 'unavailable' };
        const socket = new URL('/ws', origin);
        socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
        socket.searchParams.set(
          'orchestrationProtocol',
          ORCHESTRATION_PROTOCOL
        );
        socket.searchParams.set('wsTicket', ticket['ticket']);
        const reply = await transport.call(
          socket.href,
          {
            _tag: 'Request',
            id: '1',
            tag: 'peerLinks.link',
            payload: {
              url: request.url,
              pairingCode: request.pairingCode,
              access: ACCESS,
              expectedEnvironmentId: request.expectedEnvironmentId,
            },
            headers: [],
          },
          '1'
        );
        return outcomeOf(reply);
      } catch {
        return { refused: 'unavailable' };
      } finally {
        await run(['t3', 'auth', 'session', 'revoke', session.id], {
          timeoutMs: 30_000,
        });
      }
    },
  };
}

/** The origin the manager's T3 server records for itself, when it is on
 * this machine: a code is never sent anywhere else. */
async function loopbackOrigin(
  read: (path: string) => Promise<string>,
  home: string
): Promise<string | undefined> {
  try {
    const runtime: unknown = JSON.parse(
      await read(join(home, 'userdata/server-runtime.json'))
    );
    if (!record(runtime) || typeof runtime['origin'] !== 'string') return;
    const origin = new URL(runtime['origin']);
    return origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      ? origin.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function parseSession(text: string): { id: string; token: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    return record(value) &&
      typeof value['sessionId'] === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(value['sessionId']) &&
      typeof value['token'] === 'string' &&
      value['token'].length > 0
      ? { id: value['sessionId'], token: value['token'] }
      : null;
  } catch {
    return null;
  }
}

/** The end of the call: the link T3 made, or why it refused. */
function outcomeOf(reply: unknown): LinkOutcome {
  if (!record(reply) || reply['_tag'] !== 'Exit' || !record(reply['exit']))
    return { refused: 'unavailable' };
  const exit = reply['exit'];
  if (exit['_tag'] === 'Success' && record(exit['value'])) {
    const id = exit['value']['environmentId'];
    return typeof id === 'string' && ENVIRONMENT.test(id)
      ? { environmentId: id }
      : { refused: 'unavailable' };
  }
  return { refused: refusal(exit['cause']) };
}

/** T3's own reason for a failed call: a word, never its message. */
function refusal(cause: unknown): string {
  const first: unknown = Array.isArray(cause) ? cause[0] : undefined;
  const error = record(first) ? first['error'] : undefined;
  const reason = record(error) ? error['reason'] : undefined;
  return typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason)
    ? reason
    : 'unavailable';
}

const webTransport: T3Transport = {
  async post(url, bearer) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? ((await response.json()) as unknown) : null;
  },
  call(url, message, id) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout'));
      }, 60_000);
      const end = (value: unknown, error?: Error) => {
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(value);
      };
      socket.onopen = () => socket.send(JSON.stringify(message));
      socket.onmessage = (event) => {
        try {
          const reply: unknown = JSON.parse(String(event.data));
          if (
            record(reply) &&
            reply['_tag'] === 'Exit' &&
            reply['requestId'] === id
          )
            end(reply);
        } catch {
          // Not the reply; keep waiting.
        }
      };
      socket.onerror = () => end(null, new Error('socket'));
      socket.onclose = () => end(null, new Error('closed'));
    });
  },
};

/** Run on the worker, as its development user, over SSH: mints a pairing
 * code for the manager with the worker's own T3 (the CLI on PATH, or the
 * pinned one the toolchain installed) and prints it as JSON on stdout. */
export const MINT_PAIRING_CODE =
  't3="$(command -v t3 || ls -d "$HOME"/.local/share/personal/tools/t3-*/t3 2>/dev/null | sort -V | tail -n 1)" && ' +
  'exec "$t3" auth pairing create --json --ttl 5m --label "dev-fleet manager"';

/** Mints a one-time pairing code on the worker. The code stays in memory. */
async function mintPairingCode(
  node: FleetNode,
  run: Runner
): Promise<string | undefined> {
  const minted = await run([...sshArgs(node), MINT_PAIRING_CODE], {
    timeoutMs: 30_000,
  });
  if (!minted.ok) return undefined;
  try {
    const value: unknown = JSON.parse(minted.stdout);
    return record(value) &&
      typeof value['credential'] === 'string' &&
      CODE.test(value['credential'])
      ? value['credential']
      : undefined;
  } catch {
    return undefined;
  }
}

export type Pairing =
  | { paired: string }
  /** The worker's T3 does not answer yet: nothing was minted. */
  | { waiting: true }
  | { failed: string };

/** Pairs the manager's T3 with the T3 environment `node` runs now: the
 * environment the worker answers as over SSH, at its private HTTPS address
 * on the tailnet. */
export async function pairWorker(
  node: FleetNode,
  run: Runner,
  manager: ManagerT3
): Promise<Pairing> {
  const identity = await observedIdentity(node, run).catch(() => undefined);
  if (!identity) return { waiting: true };
  const tailnet = await discoverTailnet(run);
  const peer = tailnet.computers.find(
    (computer) => computer.id === node.tailscaleId && computer.online
  );
  if (!peer || !/^[a-z0-9.-]+\.ts\.net$/.test(peer.dns))
    return { failed: 'unreachable' };
  const pairingCode = await mintPairingCode(node, run);
  if (!pairingCode) return { failed: 'mint' };
  const linked = await manager.link({
    url: `https://${peer.dns}`,
    pairingCode,
    expectedEnvironmentId: identity,
  });
  if ('refused' in linked) return { failed: linked.refused };
  return linked.environmentId === identity
    ? { paired: identity }
    : { failed: 'identity' };
}

/** What each refusal asks a person to do. */
function remedy(id: string, reason: string): string {
  switch (reason) {
    case 'mint':
      return `The T3 of ${id} did not mint a pairing code. Run devfleet fleet-sync --node ${id} so it runs the pinned T3, then run the command again.`;
    case 'disabled':
      return "Linked environments is off in the manager's T3. Turn it on in its Settings (Labs), or stage the fleet's T3 policy, which turns it on, with ansible/macos/manager-privilege.yml as an administrator; then run the command again.";
    case 'unavailable':
      return "The manager's T3 did not answer on this machine. Open the T3 app (or start its service), then run the command again.";
    default:
      return `The T3 of ${id} refused the link (${reason}). Check that it runs the T3 policy fleet-sync stages (Linked environments on) and answers at its private address, then run devfleet fleet-sync --node ${id}.`;
  }
}

/** The `t3:link` check of a pairing. */
export function pairingCheck(id: string, pairing: Pairing): Check {
  if ('paired' in pairing)
    return {
      id: 't3:link',
      status: 'pass',
      summary: `The manager's T3 is paired with the T3 environment ${pairing.paired} of ${id}.`,
    };
  if ('waiting' in pairing)
    return {
      id: 't3:link',
      status: 'skip',
      summary: `The T3 of ${id} does not answer yet; devfleet fleet-sync --node ${id} pairs the manager with it once it runs.`,
    };
  return {
    id: 't3:link',
    status: 'fail',
    summary: 'T3_LINK_PAIRING_FAILED',
    remedy: { action: remedy(id, pairing.failed) },
  };
}
