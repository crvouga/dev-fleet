import type { AccountSelection } from '../definition';

/** Which account an unpinned request goes to first, per the policy the fleet
 * declares for the provider. The order is deterministic: the accounts the
 * policy names, in its order, then the others in the order of their routing
 * prefix. Accounts cooling down are skipped while any other is left.
 */
export class AccountSelector {
  private readonly cooling = new Map<string, number>();
  private readonly limitedAt = new Map<string, number>();
  private turn = 0;
  readonly order: string[];

  constructor(
    prefixes: string[],
    private readonly policy: AccountSelection,
    private readonly now: () => number = Date.now
  ) {
    const label = (prefix: string) => prefix.slice(prefix.indexOf('-') + 1);
    const named = policy.order ?? [];
    const rank = (prefix: string) => {
      const position = named.indexOf(label(prefix));
      return position < 0 ? named.length : position;
    };
    this.order = [...new Set(prefixes)].sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b)
    );
  }

  /** The accounts to try for the next request, in order. */
  candidates(): string[] {
    const now = this.now();
    let order = [...this.order];
    if (this.policy.strategy === 'round-robin' && order.length) {
      const start = this.turn++ % order.length;
      order = [...order.slice(start), ...order.slice(0, start)];
    }
    if (this.policy.strategy === 'least-recently-limited')
      order.sort(
        (a, b) => (this.limitedAt.get(a) ?? 0) - (this.limitedAt.get(b) ?? 0)
      );
    return order.filter((prefix) => (this.cooling.get(prefix) ?? 0) <= now);
  }

  /** The provider limited this account; `seconds` from its Retry-After. */
  limited(prefix: string, seconds = 60): void {
    const now = this.now();
    this.limitedAt.set(prefix, now);
    this.cooling.set(prefix, now + seconds * 1000);
  }

  /** When this account's cooldown clears, if it is cooling down. */
  coolingUntil(prefix: string): number | null {
    const until = this.cooling.get(prefix) ?? 0;
    return until > this.now() ? until : null;
  }
}

/** A quota or authentication answer: the next account may still serve. */
export const accountRefused = (status: number): boolean =>
  status === 429 || status === 401 || status === 403;

/** Seconds a refused account cools down for: its Retry-After, or a minute. */
export function retryAfter(headers: Headers): number {
  const value = Number(headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 3600) : 60;
}
