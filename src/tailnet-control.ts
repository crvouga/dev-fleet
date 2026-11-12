import { record } from './config';
import type { SecretsProvider } from './secrets';

/** The tailnet control plane a fleet enrols its workers with: the hosted
 * Tailscale (API v2) or a self-hosted Headscale (its REST API). The contract
 * is "a control plane that can issue pre-authorised keys": for each new
 * worker dev-fleet asks it for one key that is single-use, pre-authorised,
 * tagged and expires within minutes. The credential that asks is the secret
 * `tailnet-admin`; it stays on the manager and never reaches a worker.
 */
export type TailnetConfig =
  | {
      api: 'tailscale';
      /** The API origin; https://api.tailscale.com when not named. */
      url?: string;
      tag: string;
    }
  | {
      api: 'headscale';
      /** The Headscale server: its API, and the login server workers use. */
      url: string;
      tag: string;
      /** The Headscale user the keys belong to (its ID from Headscale 0.26). */
      user: string;
    };

const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const TAG = /^tag:[a-z0-9][a-z0-9-]{0,62}$/;
const USER = /^[A-Za-z0-9._@-]{1,64}$/;
const TAILSCALE_API = 'https://api.tailscale.com';

/** The `tailnet` block of a fleet configuration, or null when it is invalid. */
export function parseTailnetConfig(value: unknown): TailnetConfig | null {
  if (!record(value)) return null;
  const { api, url, tag, user } = value;
  const allowed =
    api === 'headscale' ? ['api', 'url', 'tag', 'user'] : ['api', 'url', 'tag'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (!matches(tag, TAG) || (url !== undefined && !matches(url, ORIGIN)))
    return null;
  if (api === 'tailscale')
    return { api, tag, ...(typeof url === 'string' ? { url } : {}) };
  return api === 'headscale' && typeof url === 'string' && matches(user, USER)
    ? { api, url, tag, user }
    : null;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

/** The server a worker logs in to; null for the hosted Tailscale, whose
 * client already knows it.
 */
export function loginServer(config: TailnetConfig | undefined): string | null {
  return config?.api === 'headscale' ? config.url : null;
}

/** One request to the control plane, and its answer. Injected in scenarios. */
export interface ControlRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface ControlResponse {
  status: number;
  /** The parsed JSON body; null when there is none. */
  body: unknown;
}
export type ControlHttp = (request: ControlRequest) => Promise<ControlResponse>;

/** Why the control plane did not do what was asked. Never carries what it
 * answered: a body may echo the credential or a key.
 */
export class TailnetControlError extends Error {
  constructor(
    readonly code:
      | 'TAILNET_ADMIN_REQUIRED'
      | 'TAILNET_CONTROL_DENIED'
      | 'TAILNET_CONTROL_REJECTED'
      | 'TAILNET_CONTROL_UNAVAILABLE'
      | 'TAILNET_CONTROL_RESPONSE_INVALID'
  ) {
    super(code);
  }
}

export interface AuthKey {
  /** Delivered to one worker only: in its seed, or on the bootstrap's stdin. */
  key: string;
  expires: string;
}
export interface TailnetDevice {
  /** The stable node ID: what `tailscale status --json` calls ID. */
  id: string;
  name: string;
  tags: string[];
}
export interface TailnetControl {
  /** One key: single-use, pre-authorised, carrying the fleet's tag and
   * expiring after `expirySeconds` (ten minutes when not named).
   */
  createAuthKey(request: {
    worker: string;
    expirySeconds?: number;
  }): Promise<AuthKey>;
  /** Every device that carries the tag. */
  listDevices(tag: string): Promise<TailnetDevice[]>;
  deleteDevice(id: string): Promise<void>;
  /** A worker's node key never expires, so nobody renews it. Tagged devices
   * already have key expiry disabled on the hosted Tailscale; this disables
   * it for a device that has it. Headscale gives a node registered with a
   * pre-authorised key no expiry, so there it changes nothing.
   */
  disableKeyExpiry(id: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9_-]{16,256}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_EXPIRY_SECONDS = 600;

/** The control plane `config` names, asked with `credential`. */
export function tailnetControl(
  config: TailnetConfig,
  credential: string,
  http: ControlHttp = fetchHttp
): TailnetControl {
  const origin = config.url ?? TAILSCALE_API;
  const ask = async (
    method: ControlRequest['method'],
    path: string,
    body?: object
  ): Promise<unknown> => {
    let response: ControlResponse;
    try {
      response = await http({
        method,
        url: `${origin}${path}`,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new TailnetControlError('TAILNET_CONTROL_UNAVAILABLE');
    }
    if (response.status === 401 || response.status === 403)
      throw new TailnetControlError('TAILNET_CONTROL_DENIED');
    if (response.status >= 500 || response.status === 429)
      throw new TailnetControlError('TAILNET_CONTROL_UNAVAILABLE');
    if (response.status < 200 || response.status > 299)
      throw new TailnetControlError('TAILNET_CONTROL_REJECTED');
    return response.body;
  };
  const device = (id: string) => {
    if (!ID.test(id)) throw new TailnetControlError('TAILNET_CONTROL_REJECTED');
    return encodeURIComponent(id);
  };
  return config.api === 'tailscale'
    ? tailscaleApi(config, ask, device)
    : headscaleApi(config, ask, device);
}

type Ask = (
  method: ControlRequest['method'],
  path: string,
  body?: object
) => Promise<unknown>;

function seconds(request: { expirySeconds?: number }): number {
  const value = request.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  // Minutes, never hours: a key that leaks is useless soon after.
  return Math.min(Math.max(Math.floor(value), 60), 3600);
}

function authKey(key: unknown, expires: unknown): AuthKey {
  if (typeof key !== 'string' || !KEY.test(key) || typeof expires !== 'string')
    throw new TailnetControlError('TAILNET_CONTROL_RESPONSE_INVALID');
  return { key, expires };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Tailscale API v2: https://tailscale.com/api. `-` is the tailnet of the
 * credential.
 */
function tailscaleApi(
  config: TailnetConfig,
  ask: Ask,
  device: (id: string) => string
): TailnetControl {
  return {
    async createAuthKey(request) {
      const answer = await ask('POST', '/api/v2/tailnet/-/keys', {
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: false,
              preauthorized: true,
              tags: [config.tag],
            },
          },
        },
        expirySeconds: seconds(request),
        description: `devfleet ${request.worker}`.slice(0, 50),
      });
      if (!record(answer))
        throw new TailnetControlError('TAILNET_CONTROL_RESPONSE_INVALID');
      return authKey(answer['key'], answer['expires']);
    },
    async listDevices(tag) {
      const answer = await ask('GET', '/api/v2/tailnet/-/devices');
      if (!record(answer) || !Array.isArray(answer['devices']))
        throw new TailnetControlError('TAILNET_CONTROL_RESPONSE_INVALID');
      return answer['devices'].filter(record).flatMap((entry) => {
        const id = entry['nodeId'] ?? entry['id'];
        const tags = strings(entry['tags']);
        return typeof id === 'string' && tags.includes(tag)
          ? [{ id, name: String(entry['hostname'] ?? entry['name']), tags }]
          : [];
      });
    },
    async deleteDevice(id) {
      await ask('DELETE', `/api/v2/device/${device(id)}`);
    },
    async disableKeyExpiry(id) {
      await ask('POST', `/api/v2/device/${device(id)}/key`, {
        keyExpiryDisabled: true,
      });
    },
  };
}

/** Headscale's REST API (/api/v1), asked with one of its API keys. */
function headscaleApi(
  config: Extract<TailnetConfig, { api: 'headscale' }>,
  ask: Ask,
  device: (id: string) => string
): TailnetControl {
  return {
    async createAuthKey(request) {
      const expiration = new Date(
        Date.now() + seconds(request) * 1000
      ).toISOString();
      const answer = await ask('POST', '/api/v1/preauthkey', {
        user: config.user,
        reusable: false,
        ephemeral: false,
        expiration,
        aclTags: [config.tag],
      });
      const key = record(answer) ? answer['preAuthKey'] : null;
      if (!record(key))
        throw new TailnetControlError('TAILNET_CONTROL_RESPONSE_INVALID');
      return authKey(key['key'], key['expiration'] ?? expiration);
    },
    async listDevices(tag) {
      const answer = await ask('GET', '/api/v1/node');
      if (!record(answer) || !Array.isArray(answer['nodes']))
        throw new TailnetControlError('TAILNET_CONTROL_RESPONSE_INVALID');
      return answer['nodes'].filter(record).flatMap((entry) => {
        const id = entry['id'];
        // Headscale has named a node's tags differently across releases.
        const tags = [
          ...new Set([
            ...strings(entry['tags']),
            ...strings(entry['forcedTags']),
            ...strings(entry['validTags']),
          ]),
        ];
        return (typeof id === 'string' || typeof id === 'number') &&
          tags.includes(tag)
          ? [
              {
                id: String(id),
                name: String(entry['givenName'] ?? entry['name']),
                tags,
              },
            ]
          : [];
      });
    },
    async deleteDevice(id) {
      await ask('DELETE', `/api/v1/node/${device(id)}`);
    },
    async disableKeyExpiry(id) {
      device(id);
    },
  };
}

/** The fleet's control plane, or null when it declares none. A declared one
 * without its credential is refused: nothing is enrolled on a guess.
 */
export async function fleetTailnetControl(
  config: TailnetConfig | undefined,
  secret: SecretsProvider,
  http?: ControlHttp
): Promise<TailnetControl | null> {
  if (!config) return null;
  const credential = await secret('tailnet-admin');
  if (!credential) throw new TailnetControlError('TAILNET_ADMIN_REQUIRED');
  return tailnetControl(config, credential, http);
}

/** What each code asks the operator to do. Never what the server answered. */
export function controlRemedy(code: TailnetControlError['code']): string {
  return {
    TAILNET_ADMIN_REQUIRED:
      'fleet.json declares a tailnet control plane, but the secrets provider holds no tailnet-admin. Store an API credential that can create auth keys there (a Tailscale API access token or OAuth client secret with the auth_keys and devices scopes, or a Headscale API key), then rerun.',
    TAILNET_CONTROL_DENIED:
      'The control plane refused the tailnet-admin credential. Replace it with one that is valid and may create tagged auth keys for the fleet tag, then rerun.',
    TAILNET_CONTROL_REJECTED:
      'The control plane refused the request. Check that the tag in fleet.json (tailnet.tag) exists and that the credential may use it, and for Headscale that tailnet.user names an existing user, then rerun.',
    TAILNET_CONTROL_UNAVAILABLE:
      'The control plane could not be reached or is busy. Check tailnet.url and the network, then rerun.',
    TAILNET_CONTROL_RESPONSE_INVALID:
      'The control plane answered with something that is not an auth key or a device list. Check that tailnet.api names the right kind of server, then rerun.',
  }[code];
}

const fetchHttp: ControlHttp = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: request.body } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
};
