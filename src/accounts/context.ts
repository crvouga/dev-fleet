import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { accountPrefix, discoverAccounts } from '../agents/accounts';
import { proxyKey } from '../agents/secrets';
import { registry } from '../agents/registry';
import type { AccountContext } from '../agents/native-verify';
import type { Check } from '../types';
import {
  nativeLoginCheck,
  nativeLogins,
  proxyReachableCheck,
  rosterCurrentCheck,
} from './checks';
import { liveVersion, rosterVersion } from './roster';
import { exposedInstances, type Instance } from './sessions';

/** This machine's T3 settings, where its account instances are written. */
export const t3Settings = (): string =>
  join(
    resolve(process.env['T3CODE_HOME'] ?? join(homedir(), '.t3')),
    'userdata/settings.json'
  );

/** A short digest of the client key: its version, never its value. */
export const keyVersion = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 12);

/** The roster version of the instances a node offers. */
export function exposedVersion(instances: Instance[]): string {
  return rosterVersion(
    instances.flatMap((instance) => {
      try {
        return [accountPrefix(instance.tool, instance.account)];
      } catch {
        return [];
      }
    })
  );
}

/** The proxy's accounts and what this node offers, read with this node's
 * own key; undefined when the proxy or the key is unavailable (the provider
 * checks report that).
 */
export async function accountContext(
  settings = t3Settings()
): Promise<AccountContext | undefined> {
  try {
    const key = await proxyKey();
    const live = await discoverAccounts(key);
    return {
      live,
      exposed: await exposedInstances(settings),
      rosterVersion: liveVersion(live),
      keyVersion: keyVersion(key),
    };
  } catch {
    return undefined;
  }
}

/** What a node measures about accounts: it reaches the proxy, it offers
 * the proxy's roster, and it holds no provider login of its own.
 */
export async function nodeAccountChecks(
  context: AccountContext | undefined,
  settings = t3Settings()
): Promise<Check[]> {
  const exposed = context?.exposed ?? (await exposedInstances(settings));
  return [
    await proxyReachableCheck(registry.proxy.endpoint),
    rosterCurrentCheck(context?.rosterVersion ?? null, exposedVersion(exposed)),
    nativeLoginCheck(nativeLogins()),
  ];
}
