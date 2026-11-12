import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Check } from '../types';
import type { ProxyRoster, RosterAccount } from './roster';

/** Fewer usable accounts than this warns unless the fleet says otherwise. */
export const MINIMUM_USABLE = 2;

/** `proxy:account:<provider>`: fails when a provider has no usable account,
 * warns below the fleet's minimum. Accounts are named by their opaque index
 * and counts only, never by an identifier.
 */
export function providerAccountChecks(
  roster: ProxyRoster,
  minimumUsable = MINIMUM_USABLE
): Check[] {
  const providers = new Map<string, RosterAccount[]>();
  for (const account of roster.accounts)
    if (account.state !== 'removed')
      providers.set(account.provider, [
        ...(providers.get(account.provider) ?? []),
        account,
      ]);
  return [...providers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, accounts]) =>
      providerCheck(provider, accounts, minimumUsable)
    );
}

/** "account 2 needs-login, account 3 cooling-down until …" */
const describe = (accounts: RosterAccount[]): string[] =>
  accounts
    .filter((account) => account.state !== 'usable')
    .map(
      (account) =>
        `account ${account.index} ${account.state}${account.until ? ` until ${account.until}` : ''}`
    );

function reloginRemedy(provider: string, accounts: RosterAccount[]) {
  const login = accounts.find((account) => account.state === 'needs-login');
  return login
    ? {
        action: `Sign ${provider} account ${login.index} in again. Signing in is the only manual step.`,
        command: `devfleet fleet-accounts --relogin ${provider} ${login.index}`,
      }
    : undefined;
}

function providerCheck(
  provider: string,
  accounts: RosterAccount[],
  minimumUsable: number
): Check {
  const usable = accounts.filter((account) => account.state === 'usable');
  const id = `proxy:account:${provider}`;
  const detail = describe(accounts);
  const counted = `${usable.length} of ${accounts.length} ${provider} accounts usable${detail.length ? ` (${detail.join(', ')})` : ''}`;
  const remedy = reloginRemedy(provider, accounts);
  if (usable.length === 0) return noneUsable(provider, accounts);
  if (usable.length < minimumUsable)
    return {
      id,
      status: 'warn',
      summary: `${counted}; one limit or expired login away from none.`,
      remedy: remedy ?? {
        action: `Add a ${provider} account: devfleet fleet-accounts --add ${provider}.`,
      },
    };
  return {
    id,
    status: 'pass',
    summary: `${counted}.`,
    ...(remedy ? { remedy } : {}),
  };
}

/** No usable account: say why, and when the first cooldown clears. */
function noneUsable(provider: string, accounts: RosterAccount[]): Check {
  const clears = accounts
    .map((account) => account.until)
    .filter((until): until is string => until !== null)
    .sort()[0];
  const cooling = accounts.every((account) => account.state === 'cooling-down');
  const wait = `Wait until ${clears ?? 'the provider lifts the limit'}, or add an account: devfleet fleet-accounts --add ${provider}.`;
  return {
    id: `proxy:account:${provider}`,
    status: 'fail',
    summary: cooling
      ? `No usable ${provider} account: every one is cooling down${clears ? `; the first clears at ${clears}` : ''}.`
      : `No usable ${provider} account (${describe(accounts).join(', ')}).`,
    remedy: reloginRemedy(provider, accounts) ?? {
      action: cooling
        ? wait
        : `Inspect the ${provider} accounts with devfleet fleet-accounts.`,
    },
  };
}

/** `accounts:roster-current`: this node offers exactly the accounts the
 * proxy holds. `proxy` is the proxy's roster version (null: unreadable),
 * `node` the version of the account instances the node exposes.
 */
export function rosterCurrentCheck(proxy: string | null, node: string): Check {
  if (proxy === null)
    return {
      id: 'accounts:roster-current',
      status: 'warn',
      summary: `The proxy's account roster could not be read; this node offers roster version ${node}.`,
      remedy: {
        action: 'Check proxy:reachable-from, then run fleet-status again.',
      },
    };
  return proxy === node
    ? {
        id: 'accounts:roster-current',
        status: 'pass',
        summary: `This node offers the proxy's account roster (version ${node}).`,
      }
    : {
        id: 'accounts:roster-current',
        status: 'fail',
        summary: `This node offers account roster version ${node}; the proxy holds ${proxy}.`,
        remedy: {
          action: 'Propagate the accounts to every node without a full sync.',
          command: 'devfleet fleet-sync --only accounts',
        },
      };
}

/** Where agent CLIs keep a provider login of their own, relative to home. */
export const NATIVE_LOGINS: Record<string, string[]> = {
  claude: ['.claude/.credentials.json'],
  codex: ['.codex/auth.json'],
  gemini: ['.gemini/oauth_creds.json'],
  opencode: ['.local/share/opencode/auth.json'],
  grok: ['.grok/auth.json'],
};

/** The provider logins found on this node outside the proxy path. */
export function nativeLogins(
  home = homedir(),
  exists: (path: string) => boolean = existsSync
): { cli: string; path: string }[] {
  return Object.entries(NATIVE_LOGINS).flatMap(([cli, paths]) =>
    paths
      .map((path) => join(home, path))
      .filter((path) => exists(path))
      .map((path) => ({ cli, path }))
  );
}

/** `accounts:native-login`: a node holds no provider login of its own, so it
 * can use no account the proxy does not know. Names the CLIs only.
 */
export function nativeLoginCheck(found: { cli: string }[]): Check {
  const clis = [...new Set(found.map((login) => login.cli))].sort();
  return clis.length === 0
    ? {
        id: 'accounts:native-login',
        status: 'pass',
        summary:
          'No agent CLI on this node holds a provider login of its own; every account comes from the proxy.',
      }
    : {
        id: 'accounts:native-login',
        status: 'warn',
        summary: `Provider logins outside the proxy path: ${clis.join(', ')}.`,
        remedy: {
          action:
            'Provider accounts belong on the proxy. Remove these logins (opt-in), and sign the account in on the proxy if it is needed.',
          command: 'devfleet fleet-accounts --remove-native-logins --yes',
        },
      };
}

/** `proxy:reachable-from`: this node reaches the proxy, and how fast. */
export async function proxyReachableCheck(
  endpoint: string,
  send: typeof fetch = fetch,
  clock: () => number = () => performance.now()
): Promise<Check> {
  const started = clock();
  try {
    // Unauthenticated: the proxy refuses it, which proves it answered.
    const response = await send(endpoint + '/v1/models', {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => undefined);
    const latency = Math.round(clock() - started);
    const answered = response.status < 500;
    return {
      id: 'proxy:reachable-from',
      status: !answered ? 'fail' : latency > 2000 ? 'warn' : 'pass',
      summary: answered
        ? `The proxy answered in ${latency} ms.`
        : 'PROXY_UNREACHABLE: the route to the proxy answered, the proxy did not.',
      ...(answered
        ? {}
        : {
            remedy: {
              action:
                'Agents retry for about a minute and then report "proxy unreachable". Check the proxy on the manager: devfleet cliproxy status.',
            },
          }),
    };
  } catch {
    return {
      id: 'proxy:reachable-from',
      status: 'fail',
      summary: 'PROXY_UNREACHABLE: no answer from the proxy.',
      remedy: {
        action:
          'Agents retry for about a minute and then report "proxy unreachable". Check this node’s tailnet and the proxy on the manager: devfleet cliproxy status.',
      },
    };
  }
}
