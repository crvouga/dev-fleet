import { readFile } from 'node:fs/promises';
import type { Account } from '../agents/accounts';
import type { Check } from '../types';

/** The tools T3 offers once per proxy account, by T3 driver. */
const DRIVERS: Record<string, string> = {
  claudeAgent: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/** One per-account instance a node offers: its tool and account. */
export interface Instance {
  tool: string;
  account: string;
}

/** The per-account instances this node's T3 settings offer, read from the
 * account each one pins (WS_AGENT_ACCOUNT). An unreadable file offers none.
 */
export async function exposedInstances(settings: string): Promise<Instance[]> {
  try {
    const parsed = JSON.parse(await readFile(settings, 'utf8')) as {
      providerInstances?: Record<
        string,
        {
          driver?: unknown;
          environment?: { name?: unknown; value?: unknown }[];
        }
      >;
    };
    return Object.values(parsed.providerInstances ?? {}).flatMap((instance) => {
      const tool = DRIVERS[String(instance.driver)];
      const account = (instance.environment ?? []).find(
        (variable) => variable.name === 'WS_AGENT_ACCOUNT'
      )?.value;
      return tool && typeof account === 'string' ? [{ tool, account }] : [];
    });
  } catch {
    return [];
  }
}

export type SessionResult = 'ok' | 'cooling-down' | 'failed';

/** Runs one real, cheap session through the instance's launcher. */
export type Session = (instance: Instance) => Promise<SessionResult>;

/** `agent:<tool>:account-<index>:session`, one per account instance: the
 * accounts the proxy holds and any instance the node still offers. An
 * instance whose account the proxy no longer holds fails without being run;
 * a rate-limited account is `cooling-down`, a warning and never a pass. The
 * index is the account's position among its provider's, never its name.
 */
export async function accountSessionChecks(
  live: Account[],
  exposed: Instance[],
  session: Session
): Promise<Check[]> {
  const key = (instance: Instance) => `${instance.tool}\0${instance.account}`;
  const held = new Set(
    live.map((account) => key({ tool: account.tool, account: account.email }))
  );
  const index = (instance: Instance) =>
    live
      .filter((account) => account.tool === instance.tool)
      .findIndex((account) => account.email === instance.account) + 1;
  const removed = exposed.filter((instance) => !held.has(key(instance)));
  const checks = await Promise.all(
    live.map(async (account): Promise<Check> => {
      const instance = { tool: account.tool, account: account.email };
      const id = `agent:${account.tool}:account-${index(instance)}:session`;
      const result = await session(instance);
      if (result === 'ok')
        return {
          id,
          status: 'pass',
          summary: `${account.tool} account ${index(instance)} runs a session through its T3 launcher.`,
        };
      if (result === 'cooling-down')
        return {
          id,
          status: 'warn',
          summary: `AGENT_ACCOUNT_COOLING_DOWN: ${account.tool} account ${index(instance)} is rate limited; checked again on the next status.`,
        };
      return {
        id,
        status: 'fail',
        summary: `AGENT_ACCOUNT_SESSION_FAILED: ${account.tool} account ${index(instance)} did not run a session.`,
        remedy: {
          action: 'Check this account on the proxy.',
          command: 'devfleet fleet-accounts',
        },
      };
    })
  );
  const byTool = new Map<string, number>();
  for (const instance of removed) {
    const count = (byTool.get(instance.tool) ?? 0) + 1;
    byTool.set(instance.tool, count);
    checks.push({
      id: `agent:${instance.tool}:removed-${count}:session`,
      status: 'fail',
      summary: `AGENT_ACCOUNT_REMOVED: this node still offers a ${instance.tool} instance for an account the proxy no longer holds.`,
      remedy: {
        action: 'Propagate the accounts to every node.',
        command: 'devfleet fleet-sync --only accounts',
      },
    });
  }
  return checks;
}

/** What a session's output says about its account. */
export function sessionResult(ok: boolean, output: string): SessionResult {
  if (ok && /\bOK\b/.test(output)) return 'ok';
  if (/cooling down until|rate[ _-]?limit|\b429\b|quota/i.test(output))
    return 'cooling-down';
  return 'failed';
}
