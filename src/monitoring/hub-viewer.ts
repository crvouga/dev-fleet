import { randomBytes } from 'node:crypto';
import { record } from '../config';
import type { Check } from '../types';
import { publicViewerIdentity } from './hub-access';

/** Loopback address of the hub container on the manager. */
export const LOCAL_HUB = 'http://127.0.0.1:8090';

type Fetcher = typeof fetch;
export interface HubLogin {
  identity: string;
  password: string;
}

function viewerCheck(
  status: Check['status'],
  summary: string,
  action?: string
): Check {
  return {
    id: 'beszel:public-viewer',
    status,
    summary,
    ...(action ? { remedy: { action } } : {}),
  };
}

export interface Session {
  fetcher: Fetcher;
  base: string;
  token: string;
}

export async function api(
  session: Session,
  method: string,
  path: string,
  body?: object
): Promise<unknown> {
  const response = await session.fetcher(`${session.base}${path}`, {
    method,
    headers: {
      Authorization: session.token,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  // Bodies can echo emails or tokens: only the status is ever surfaced.
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function superuserToken(
  session: Session,
  login: HubLogin
): Promise<string> {
  const auth = await api(
    session,
    'POST',
    '/api/collections/_superusers/auth-with-password',
    login
  );
  if (!record(auth) || typeof auth['token'] !== 'string')
    throw new Error('BESZEL_PROTOCOL');
  return auth['token'];
}

async function findViewer(
  session: Session
): Promise<{ id: string; role: unknown } | null> {
  const filter = encodeURIComponent(`email="${publicViewerIdentity()}"`);
  const list = await api(
    session,
    'GET',
    `/api/collections/users/records?filter=${filter}&perPage=2`
  );
  const items =
    record(list) && Array.isArray(list['items']) ? list['items'] : [];
  const first: unknown = items[0];
  if (!record(first) || typeof first['id'] !== 'string') return null;
  return { id: first['id'], role: first['role'] };
}

async function createViewer(session: Session): Promise<void> {
  const password = randomBytes(24).toString('base64url');
  await api(session, 'POST', '/api/collections/users/records', {
    email: publicViewerIdentity(),
    username: 'public-viewer',
    password,
    passwordConfirm: password,
    verified: true,
    role: 'readonly',
  });
}

/** Idempotently makes sure the read-only viewer exists, then re-reads it to
 * prove its role. AUTO_LOGIN signs every visitor in as this account, so an
 * existing account with any other role is demoted rather than trusted. The
 * password is random, never stored or printed, and is not needed to sign in.
 */
export async function ensurePublicViewer(
  login: HubLogin | null,
  fetcher: Fetcher = fetch,
  base: string = LOCAL_HUB
): Promise<Check> {
  if (!login)
    return viewerCheck(
      'warn',
      'BESZEL_VIEWER_UNPROVISIONED',
      "The fleet admin login is unavailable. Log the manager's Vault session in with read access to BESZEL_FLEET_AUTH and rerun fleet-sync; until then the public dashboard shows the login page."
    );
  try {
    const anonymous: Session = { fetcher, base, token: '' };
    const session = {
      ...anonymous,
      token: await superuserToken(anonymous, login),
    };
    const existing = await findViewer(session);
    if (!existing) await createViewer(session);
    else if (existing.role !== 'readonly')
      await api(
        session,
        'PATCH',
        `/api/collections/users/records/${existing.id}`,
        { role: 'readonly' }
      );
    const verified = await findViewer(session);
    if (verified?.role !== 'readonly') throw new Error('BESZEL_VIEWER_ROLE');
    return viewerCheck(
      'pass',
      `Visitors are signed in automatically as ${publicViewerIdentity()} (read-only).`
    );
  } catch {
    return viewerCheck(
      'warn',
      'BESZEL_VIEWER_UNVERIFIED',
      `Could not create or verify the read-only ${publicViewerIdentity()} user with the fleet admin login. Create it in the hub (Settings > Users, role Read-only); never make it an admin. Details are withheld.`
    );
  }
}
