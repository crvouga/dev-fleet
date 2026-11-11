import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { object, read, write } from './files';

/** One naming convention for every provider T3 lists, on every machine:
 * `<Provider> CLI Proxy` for a fleet-managed gateway instance and
 * `<Provider> <account email>` for a native login.
 */
export const PROVIDER_NAMES: Record<string, string> = {
  claudeAgent: 'Claude',
  codex: 'Codex',
  antigravity: 'AntiGravity',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
};

export const proxyName = (driver: string): string | undefined =>
  PROVIDER_NAMES[driver] && `${PROVIDER_NAMES[driver]} CLI Proxy`;

/** The account email is the only identity shown; without one the provider
 * name stands alone rather than a guess.
 */
export const accountName = (
  driver: string,
  email?: string
): string | undefined =>
  PROVIDER_NAMES[driver] &&
  (email ? `${PROVIDER_NAMES[driver]} ${email}` : PROVIDER_NAMES[driver]);

export type Accounts = (
  driver: string,
  homePath?: string
) => Promise<string | undefined>;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const email = (value: unknown): string | undefined =>
  typeof value === 'string' && EMAIL.test(value) ? value : undefined;

async function json(path: string): Promise<Record<string, unknown>> {
  return object(await readFile(path, 'utf8'));
}

/** Reads only the signed-in address from each client's own login record; a
 * token is never returned, logged or sent anywhere.
 */
export const localAccounts: Accounts = async (driver, homePath) => {
  try {
    if (driver === 'claudeAgent') {
      const account = (await json(join(homePath ?? homedir(), '.claude.json')))[
        'oauthAccount'
      ];
      return email((account as Record<string, unknown>)?.['emailAddress']);
    }
    if (driver === 'codex') {
      const home =
        homePath ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
      const tokens = (await json(join(home, 'auth.json')))['tokens'];
      const claims = String(
        (tokens as Record<string, unknown>)?.['id_token']
      ).split('.')[1];
      return email(
        object(Buffer.from(claims ?? '', 'base64url').toString('utf8'))['email']
      );
    }
  } catch {
    /* Signed out or unreadable: the provider name stands alone. */
  }
  return undefined;
};

type Instance = Record<string, unknown>;
const homeOf = (instance: Instance): string | undefined => {
  const home = (instance['config'] as Record<string, unknown> | undefined)?.[
    'homePath'
  ];
  return typeof home === 'string' ? home : undefined;
};

/** Every instance T3 lists gets its conventional name. Managed instances
 * (`managed`: ID to name) are named by their definition; every other instance is renamed after its own
 * signed-in account, and a signed-in default login T3 lists without a settings
 * entry gains one. Only `displayName` is ever written.
 */
export async function conformNames(
  current: Record<string, unknown>,
  managed: Record<string, string>,
  accounts: Accounts = localAccounts
): Promise<Record<string, unknown>> {
  const next: Record<string, unknown> = { ...current };
  const named = new Set<string>();
  for (const [id, value] of Object.entries(current)) {
    // A worker's policy owns its managed instances; a copy left in its
    // settings still shows until the policy loads, so it conforms too.
    const renamed = Object.hasOwn(managed, id)
      ? rename(value, () => managed[id])
      : rename(value, accountName, await account(value, accounts));
    if (!renamed) continue;
    named.add(String(renamed['displayName']));
    next[id] = renamed;
  }
  // T3 lists a driver's default instance (its ID is the driver) without an entry.
  for (const driver of Object.keys(PROVIDER_NAMES)) {
    const account = await accounts(driver);
    const name = account && accountName(driver, account);
    if (!name || named.has(name) || Object.hasOwn(current, driver)) continue;
    next[driver] = { driver, displayName: name };
  }
  return next;
}

const account = (value: unknown, accounts: Accounts) =>
  value && typeof value === 'object'
    ? accounts(String((value as Instance)['driver']), homeOf(value as Instance))
    : undefined;

/** The instance under its conventional name; undefined for an unknown driver. */
function rename(
  value: unknown,
  convention: (driver: string, email?: string) => string | undefined,
  email?: string
): Instance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const instance = value as Instance;
  const name = convention(String(instance['driver']), email);
  if (!name) return undefined;
  return instance['displayName'] === name
    ? instance
    : { ...instance, displayName: name };
}

/** Applies the convention to this machine's T3 settings. T3 watches the file,
 * so names change live; nothing is restarted. Returns whether it changed.
 */
export async function conformT3Names(
  settingsPath: string,
  managed: Record<string, string>,
  options: { apply: boolean; accounts?: Accounts }
): Promise<{ changed: boolean }> {
  const raw = await read(settingsPath);
  const settings = object(raw);
  const current = object(JSON.stringify(settings['providerInstances'] ?? {}));
  const next = await conformNames(current, managed, options.accounts);
  if (JSON.stringify(next) === JSON.stringify(current))
    return { changed: false };
  if (!options.apply) return { changed: true };
  // T3 also writes this file: never overwrite a change made since the read.
  if ((await read(settingsPath)) !== raw) throw new Error('T3_SETTINGS_BUSY');
  await write(
    settingsPath,
    JSON.stringify({ ...settings, providerInstances: next }, null, 2) + '\n'
  );
  return { changed: true };
}
