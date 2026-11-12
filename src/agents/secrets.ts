import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentConfigurationError } from './errors';
import { secret } from '../fleet-config';

/** Where a node keeps the last proxy client key its secrets provider gave it,
 * readable by its user alone. Disposable: the next successful read rewrites it.
 */
export const lastProxyKeyPath = (home = homedir()): string =>
  join(home, '.cache/dev-fleet/proxy-client-key');

/** The key every node presents to the CLI proxy, from this fleet's secrets
 * provider with this node's own access. The provider stays the source: a key
 * rotated there is used at the next launch. When the provider cannot answer
 * (Vault unreachable, or this node's session expired) the last key it gave is
 * used instead, so an outage of the secrets provider never takes every agent
 * down with it; the node's own Vault checks still fail until it is repaired.
 */
export async function proxyKey(
  options: {
    read?: () => Promise<string | null>;
    path?: string;
  } = {}
): Promise<string> {
  const read = options.read ?? (() => secret('proxy-client-key'));
  const path = options.path ?? lastProxyKeyPath();
  const value = await read().catch(() => null);
  if (value) {
    await remember(path, value).catch(() => undefined);
    return value;
  }
  const last = (await readFile(path, 'utf8').catch(() => '')).trim();
  if (last) return last;
  throw new AgentConfigurationError(
    "Required secret unavailable: proxy-client-key. Restore this node's access to the fleet's secrets provider (see `secrets` in the fleet configuration)."
  );
}

async function remember(path: string, value: string): Promise<void> {
  if ((await readFile(path, 'utf8').catch(() => '')).trim() === value) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  // Written aside and renamed, so a launch never reads half a key.
  const staged = `${path}.${process.pid}`;
  await writeFile(staged, `${value}\n`, { mode: 0o600 });
  await rename(staged, path);
}
