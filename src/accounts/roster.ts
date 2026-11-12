import { createHash } from 'node:crypto';
import type { Account } from '../agents/accounts';

/** Provider accounts exist only as the CLI proxy's credential files. Every
 * node and IDE gets a view derived from them; nothing on a node holds a
 * provider login. See docs/accounts.md.
 */
export type AccountState =
  'usable' | 'cooling-down' | 'needs-login' | 'refresh-failing' | 'removed';

const STATES: AccountState[] = [
  'usable',
  'cooling-down',
  'needs-login',
  'refresh-failing',
  'removed',
];

/** One account as the manager reports it. `index` is opaque: the position of
 * the account among its provider's, the only way checks name it.
 */
export interface RosterAccount {
  provider: string;
  index: number;
  label: string;
  /** The routing prefix every node offers it under; null if not routed. */
  prefix: string | null;
  state: AccountState;
  /** While cooling down: when it clears (ISO 8601), when known. */
  until: string | null;
}

/** What `devfleet cliproxy accounts --json` prints on the manager. */
export interface ProxyRoster {
  version: 1;
  rosterVersion: string;
  /** Whether the proxy's management API answered: without it, cooldowns and
   * refresh failures are not known.
   */
  managementApi: boolean;
  accounts: RosterAccount[];
}

export function parseRoster(text: string): ProxyRoster {
  const value = JSON.parse(text) as Partial<ProxyRoster>;
  if (
    value.version !== 1 ||
    typeof value.rosterVersion !== 'string' ||
    !Array.isArray(value.accounts) ||
    !value.accounts.every(
      (account) =>
        typeof account.provider === 'string' &&
        Number.isInteger(account.index) &&
        typeof account.label === 'string' &&
        STATES.includes(account.state)
    )
  )
    throw new Error('The proxy reported an unreadable account roster.');
  return {
    version: 1,
    rosterVersion: value.rosterVersion,
    managementApi: value.managementApi === true,
    accounts: value.accounts.map((account) => ({
      ...account,
      prefix: account.prefix ?? null,
      until: account.until ?? null,
    })),
  };
}

/** The roster version: a digest of the routing prefixes of the accounts
 * every node offers. The manager computes it from the credential files
 * (cliproxy/scripts/accounts.py) and every node from the proxy's model list;
 * the two agree exactly when the node offers what the proxy holds.
 */
export function rosterVersion(prefixes: Iterable<string>): string {
  return createHash('sha256')
    .update([...new Set(prefixes)].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/** The version of the accounts a node reads from the proxy's model list. */
export const liveVersion = (accounts: Account[]): string =>
  rosterVersion(accounts.map((account) => account.prefix));
