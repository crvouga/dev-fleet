import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { pinnedPath } from '../agents/toolchain';
import { PACKAGE_ROOT } from '../package-info';
import type { Runner } from '../types';
import type { Bucket } from './bucket';

/** Where this code runs from: its mise.toml pins Litestream. */
const SOURCE = PACKAGE_ROOT;

export interface Replication {
  database: string;
  bucket: Bucket;
  run: Runner;
  /** False for a read-only command: it does not install the binary. */
  install?: boolean;
}

const located = new WeakMap<Runner, Promise<string | null>>();

/** The pinned Litestream binary. It is a lazy mise pin, installed the first
 * time the manager needs it; workers never do.
 */
function binary(run: Runner, install: boolean): Promise<string | null> {
  // An installed package is a directory nobody ran `mise trust` in. Its pins
  // are trusted for these commands only; nothing is recorded on the machine.
  const options = {
    cwd: SOURCE,
    env: { PATH: pinnedPath(), MISE_TRUSTED_CONFIG_PATHS: SOURCE },
  };
  const locate = async (): Promise<string | null> => {
    const which = await run(['mise', 'which', 'litestream'], options);
    const path = which.stdout.trim();
    return which.ok && path.startsWith('/') ? path : null;
  };
  const known = located.get(run);
  if (known) return known;
  const found = locate().then(async (path) => {
    if (path || !install) return path;
    await run(['mise', 'install', 'litestream'], {
      ...options,
      timeoutMs: 180_000,
    });
    return locate();
  });
  // A missing binary is looked for again: a later command may install it.
  void found.then((path) => {
    if (!path) located.delete(run);
  });
  located.set(run, found);
  return found;
}

function replica(database: string, bucket: Bucket): Record<string, unknown> {
  if (bucket.kind === 'directory')
    return { type: 'file', path: join(bucket.path, basename(database)) };
  return {
    type: 's3',
    bucket: bucket.bucket,
    path: `${bucket.prefix}/${basename(database)}`,
    ...(bucket.region ? { region: bucket.region } : {}),
    // Every S3-compatible service answers path-style requests.
    ...(bucket.endpoint
      ? { endpoint: bucket.endpoint, 'force-path-style': true }
      : {}),
  };
}

/** The Litestream configuration for one database. It never holds a
 * credential: those reach Litestream through its environment.
 */
export function litestreamConfig(database: string, bucket: Bucket): string {
  return stringify({
    logging: { level: 'error' },
    // Each change uploads a full snapshot (the database is a few kilobytes),
    // so a restore reads one object however long the history is.
    snapshot: { interval: '24h', retention: '720h' },
    dbs: [{ path: database, replica: replica(database, bucket) }],
  });
}

export function litestreamEnvironment(bucket: Bucket): Record<string, string> {
  return bucket.kind === 's3' && bucket.accessKeyId && bucket.secretAccessKey
    ? {
        // The standard names: they replace any keys in the operator's shell,
        // which Litestream would otherwise prefer.
        AWS_ACCESS_KEY_ID: bucket.accessKeyId,
        AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
        // These keys are not a session's: a token left in the shell must
        // not be sent with them.
        AWS_SESSION_TOKEN: '',
      }
    : {};
}

/** Litestream is run once per change rather than as a daemon: a devfleet
 * command that changed the state has not finished until the bucket has it,
 * and nothing has to be kept running on the manager.
 */
async function invoke(
  { database, bucket, run, install }: Replication,
  command: string,
  args: string[]
): Promise<boolean> {
  const litestream = await binary(run, install !== false);
  if (!litestream) return false;
  const config = join(dirname(database), 'litestream.yml');
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  writeFileSync(config, litestreamConfig(database, bucket), { mode: 0o600 });
  const result = await run(
    [litestream, command, '-no-expand-env', '-config', config, ...args],
    // A bucket that does not answer must not hold a fleet-sync up for long.
    { timeoutMs: 60_000, env: litestreamEnvironment(bucket) }
  );
  return result.ok;
}

/** Uploads everything the bucket does not have yet. */
export async function replicate(target: Replication): Promise<boolean> {
  return invoke(target, 'replicate', [
    '-once',
    '-force-snapshot',
    '-enforce-retention',
  ]);
}

/** Downloads the bucket's latest version to `output`, which must not exist.
 * `absent` means the bucket is reachable and holds no state yet.
 */
export async function restore(
  target: Replication,
  output: string
): Promise<'restored' | 'absent' | 'failed'> {
  const ran = await invoke(target, 'restore', [
    '-if-replica-exists',
    '-o',
    output,
    target.database,
  ]);
  if (!ran) return 'failed';
  return existsSync(output) ? 'restored' : 'absent';
}
