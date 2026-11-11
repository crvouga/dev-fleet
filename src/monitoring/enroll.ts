import { createHash, randomUUID } from 'node:crypto';
import { record } from '../config';
import { privateHub } from './beszel';

export type HubRequest = (path: string, body?: object) => Promise<unknown>;
export interface AgentEnrollment {
  systemId: string;
  hubUrl: string;
  publicKey: string;
  token: string;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (
    !record(value) ||
    !Array.isArray(value['items']) ||
    !value['items'].every(record)
  )
    throw new Error('BESZEL_PROTOCOL');
  return value['items'];
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]{15}$/.test(value))
    throw new Error('BESZEL_PROTOCOL');
  return value;
}
/** Mutating API adapter: call only after fleet approval and under manager lock.
 * Uses the same systems/fingerprints API as upstream Add System, never its DB.
 * The returned token is secret material: pass only through private SSH stdin.
 */
export async function enrollBeszel(
  input: { node: string; hub: string; userId: string; host: string },
  request: HubRequest
): Promise<AgentEnrollment> {
  const hubUrl = privateHub(input.hub);
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(input.node) ||
    !/^[a-z0-9.-]+\.ts\.net$/.test(input.host)
  )
    throw new Error('BESZEL_NODE_INVALID');
  const info = await hubInfo(request);
  const systemId = await ensureSystem(input, request);
  const fingerprints = rows(
    await request(
      `/api/collections/fingerprints/records?filter=${encodeURIComponent(`system="${systemId}"`)}&perPage=2`
    )
  );
  if (fingerprints.length > 1) throw new Error('BESZEL_DUPLICATE_FINGERPRINT');
  let token = fingerprints[0]?.['token'];
  if (fingerprints.length === 0) {
    token = randomUUID();
    await request('/api/collections/fingerprints/records', {
      id: createHash('sha256')
        .update(`personal:fingerprint:${systemId}`)
        .digest('hex')
        .slice(0, 15),
      system: systemId,
      token,
    });
  }
  if (
    typeof token !== 'string' ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_-]{15,63}$/.test(token)
  )
    throw new Error('BESZEL_TOKEN_INVALID');
  return { systemId, hubUrl, publicKey: info['key'], token };
}
async function ensureSystem(
  input: { node: string; userId: string; host: string },
  request: HubRequest
): Promise<string> {
  const systems = rows(
    await request(
      `/api/collections/systems/records?filter=${encodeURIComponent(`name="${input.node}"`)}&perPage=2`
    )
  );
  if (systems.length > 1) throw new Error('BESZEL_DUPLICATE_NODE');
  if (systems[0]) {
    if (systems[0]['host'] !== input.host)
      throw new Error('BESZEL_HOST_CONFLICT');
    return identifier(systems[0]['id']);
  }
  const id = createHash('sha256')
    .update(`personal:system:${input.node}`)
    .digest('hex')
    .slice(0, 15);
  const created = await request('/api/collections/systems/records', {
    id,
    name: input.node,
    host: input.host,
    port: '45876',
    users: [identifier(input.userId)],
  });
  if (!record(created) || created['id'] !== id)
    throw new Error('BESZEL_PROTOCOL');
  return id;
}

async function hubInfo(
  request: HubRequest
): Promise<Record<string, unknown> & { key: string }> {
  const info = await request('/api/beszel/info');
  if (
    !record(info) ||
    info['v'] !== '0.21.1' ||
    typeof info['key'] !== 'string' ||
    !info['key'].startsWith('ssh-ed25519 ')
  )
    throw new Error('BESZEL_VERSION_OR_KEY');
  return info as Record<string, unknown> & { key: string };
}
