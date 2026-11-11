import { privateHub } from './beszel';
import type { HubRequest } from './enroll';
import { record } from '../config';
import { fleet, secret } from '../fleet-config';

/** The normal (non-superuser) Beszel account the manager enrolls nodes with.
 * Its password is the fleet's monitoring-account-password secret. A fresh hub on the
 * manager creates the account itself on first start (hub-darwin.yml).
 */
export const BESZEL_FLEET_IDENTITY = fleet.services.monitoring.managerAccount;

/** Read-only Beszel user the hub signs every visitor in as (AUTO_LOGIN), so the
 * dashboard needs no login. Create it once in the hub (Settings > Users, role
 * "Read-only"); it holds no secret and must never be an admin. If the account
 * does not exist the hub simply shows its normal login page.
 */
export const BESZEL_PUBLIC_VIEWER_IDENTITY =
  fleet.services.monitoring.viewerAccount;

/** Accept the plain password, or a legacy JSON identity/password pair. */
export function fleetCredentials(secret: string): {
  identity: string;
  password: string;
} {
  const value = secret.trim();
  if (!value) throw new Error('BESZEL_ACCOUNT_INVALID');
  if (value.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('BESZEL_ACCOUNT_INVALID');
    }
    if (
      !record(parsed) ||
      typeof parsed['identity'] !== 'string' ||
      typeof parsed['password'] !== 'string'
    )
      throw new Error('BESZEL_ACCOUNT_INVALID');
    return { identity: parsed['identity'], password: parsed['password'] };
  }
  return { identity: BESZEL_FLEET_IDENTITY, password: value };
}

/** The fleet login from the manager's Vault session, or null when absent.
 * Used to create the account on a hub's first start; never printed.
 */
export async function fleetAccount(): Promise<{
  identity: string;
  password: string;
} | null> {
  const password = await secret('monitoring-account-password');
  try {
    return password ? fleetCredentials(password) : null;
  } catch {
    return null;
  }
}

/** Reads the existing account password only. This never creates credentials. The normal Beszel account must have fleet-node access.
 */
export async function hubAccess(
  hub: string
): Promise<{ userId: string; request: HubRequest }> {
  const url = privateHub(hub);
  const password = await secret('monitoring-account-password');
  if (!password) throw new Error('BESZEL_ACCOUNT_REQUIRED');
  const credentials = fleetCredentials(password);
  const login = await call(
    url,
    '/api/collections/users/auth-with-password',
    '',
    credentials
  );
  if (
    !record(login) ||
    typeof login['token'] !== 'string' ||
    !record(login['record']) ||
    typeof login['record']['id'] !== 'string'
  )
    throw new Error('BESZEL_AUTH_REQUIRED');
  const token = login['token'];
  return {
    userId: login['record']['id'],
    request: (path, body) => call(url, path, token, body),
  };
}
async function call(
  url: string,
  path: string,
  token: string,
  body?: object
): Promise<unknown> {
  if (!path.startsWith('/api/')) throw new Error('BESZEL_API_PATH');
  const response = await fetch(`${url}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(failure(response.status, path));
  return response.json() as Promise<unknown>;
}

/** PocketBase answers a rejected password login with 400, not 401. */
export function failure(status: number, path: string): string {
  if (status === 400 && path.endsWith('/auth-with-password'))
    return 'BESZEL_ACCOUNT_REQUIRED';
  return status === 401 || status === 403
    ? 'BESZEL_AUTH_REQUIRED'
    : 'BESZEL_API_UNAVAILABLE';
}
