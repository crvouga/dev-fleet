import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { record } from '../config';
import { FleetUsageError } from '../errors';
import { FleetLockError } from '../machine/lock-error';
import { withMachineLock } from '../machine/state';
import { runCommand } from '../runner';
import type { Runner } from '../types';
import { bucketIdentity, type Bucket } from './bucket';
import { connection } from './connection';
import { replicate, restore } from './litestream';
import { databasePath, replicatedPath, stateRoot } from './paths';
import { managerHolder } from './holder';
import {
  StateNewerError,
  readHead,
  readLease,
  writeLease,
  type Head,
  type Lease,
} from './store';

export type { Lease } from './store';

export interface StateContext {
  root: string;
  bucket: Bucket | null;
  run: Runner;
  /** This machine, as the manager lease names it. Without one the lease is
   * neither checked nor taken.
   */
  holder?: string | null;
  /** Take the lease from another manager before it expired. */
  takeOver?: boolean;
  now?: () => Date;
}

export function stateContext(
  run: Runner = runCommand,
  env = process.env
): StateContext {
  return {
    root: stateRoot(env),
    bucket: connection(env).bucket,
    run,
    holder: managerHolder(env),
  };
}

/** How this machine's copy compares with the bucket.
 * - `local-only`: no bucket is configured; this copy is the only one.
 * - `unreachable`: the bucket did not answer, or did not take an upload.
 * - `corrupt`: the bucket answered with a version that cannot be read.
 * - `empty`: neither side holds any state.
 * - `unpublished`: the bucket holds nothing yet; this copy can seed it.
 * - `in-sync`: both hold the same version.
 * - `local-ahead`: this copy has changes the bucket has not received.
 * - `bucket-ahead`: another manager changed the bucket; this copy is stale.
 * - `diverged`: both changed. The bucket is the source of truth.
 */
export type Standing =
  | 'local-only'
  | 'unreachable'
  | 'corrupt'
  | 'empty'
  | 'unpublished'
  | 'in-sync'
  | 'local-ahead'
  | 'bucket-ahead'
  | 'diverged';

interface Replicated {
  bucket: string;
  head: string;
}

/** The bucket's head as of the last time this copy matched it. A copy whose
 * head still equals it has no changes of its own and may be replaced.
 */
function readReplicated(root: string, bucket: Bucket): Replicated | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(replicatedPath(root), 'utf8')
    );
    return record(value) &&
      value['bucket'] === bucketIdentity(bucket) &&
      typeof value['head'] === 'string'
      ? { bucket: value['bucket'], head: value['head'] }
      : null;
  } catch {
    return null;
  }
}

function saveReplicated(root: string, bucket: Bucket, head: Head): void {
  const path = replicatedPath(root);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      version: 1,
      bucket: bucketIdentity(bucket),
      head: head.id,
    }) + '\n',
    { mode: 0o600 }
  );
  renameSync(temporary, path);
}

/** Litestream's own record of what it has uploaded, next to the database. */
const bookkeeping = (database: string): string =>
  join(dirname(database), `.${basename(database)}-litestream`);

function discard(database: string): void {
  for (const path of [database, `${database}-wal`, `${database}-shm`])
    rmSync(path, { force: true });
  rmSync(bookkeeping(database), { recursive: true, force: true });
}

const INCOMING = /^incoming-[0-9a-f-]{36}\.db/;

type Remote =
  | { status: 'unreachable' }
  | { status: 'corrupt' }
  | { status: 'absent' }
  | { status: 'present'; file: string; head: Head };

/** Downloads the bucket's current version beside the local one, or the
 * version it held at `timestamp`.
 */
async function fetchRemote(
  context: StateContext & { bucket: Bucket },
  install = true,
  timestamp?: string
): Promise<Remote> {
  const database = databasePath(context.root);
  const file = join(context.root, `incoming-${randomUUID()}.db`);
  const outcome = await restore(
    { database, bucket: context.bucket, run: context.run, install },
    file,
    timestamp
  );
  if (outcome === 'absent') return { status: 'absent' };
  try {
    const head = outcome === 'restored' ? readHead(file) : null;
    if (head) return { status: 'present', file, head };
    discard(file);
    // A replica that holds no version yet is the same as no replica.
    return { status: outcome === 'restored' ? 'absent' : 'unreachable' };
  } catch (error) {
    discard(file);
    // A newer dev-fleet wrote it: refused, never taken for damage.
    if (error instanceof StateNewerError) throw error;
    // The bucket answered, and what it holds cannot be read.
    return { status: 'corrupt' };
  }
}

function compare(
  local: Head | null,
  remote: Head,
  replicated: Replicated | null
): Standing {
  if (!local) return 'bucket-ahead';
  if (remote.id === local.id) return 'in-sync';
  if (replicated?.head === local.id) return 'bucket-ahead';
  if (replicated?.head === remote.id) return 'local-ahead';
  return 'diverged';
}

interface Observation {
  standing: Standing;
  local: Head | null;
  remote: Remote | null;
}

async function observe(
  context: StateContext,
  install = true
): Promise<Observation> {
  const local = readHead(databasePath(context.root));
  const { bucket } = context;
  if (!bucket) return { standing: 'local-only', local, remote: null };
  const remote = await fetchRemote({ ...context, bucket }, install);
  if (remote.status === 'unreachable' || remote.status === 'corrupt')
    return { standing: remote.status, local, remote };
  if (remote.status === 'absent')
    return { standing: local ? 'unpublished' : 'empty', local, remote };
  const replicated = readReplicated(context.root, bucket);
  return { standing: compare(local, remote.head, replicated), local, remote };
}

/** One devfleet command at a time compares or changes the state. Downloads a
 * killed command left behind are removed while nothing else can be using one.
 */
async function locked<T>(
  root: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await withMachineLock(root, async () => {
      for (const name of readdirSync(root))
        if (INCOMING.test(name)) rmSync(join(root, name), { force: true });
      return operation();
    });
  } catch (error) {
    if (error instanceof FleetLockError)
      throw new FleetUsageError(
        'Another devfleet command is using the fleet state. Wait for it to finish, then retry.'
      );
    throw error;
  }
}

/** Replaces a stale copy with the bucket's version and records a copy that
 * already matches. `force` replaces a copy that has changes of its own too.
 */
function adopt(
  context: StateContext,
  observation: Observation,
  force: boolean
): Standing {
  const { remote, local, standing } = observation;
  if (!context.bucket || remote?.status !== 'present') return standing;
  if (standing === 'in-sync' && local)
    saveReplicated(context.root, context.bucket, local);
  if (standing === 'in-sync' || (standing !== 'bucket-ahead' && !force))
    return standing;
  const database = databasePath(context.root);
  discard(database);
  renameSync(remote.file, database);
  chmodSync(database, 0o600);
  saveReplicated(context.root, context.bucket, remote.head);
  return 'in-sync';
}

async function observed(
  context: StateContext,
  force: boolean
): Promise<Standing> {
  const observation = await observe(context);
  try {
    return adopt(context, observation, force);
  } finally {
    if (observation.remote?.status === 'present')
      discard(observation.remote.file);
  }
}

/** Uploads this copy, then downloads it again: the bucket holds this version
 * only once a restore from it returns this version.
 */
async function upload(
  context: StateContext & { bucket: Bucket },
  seed: boolean
): Promise<Standing> {
  const database = databasePath(context.root);
  const head = readHead(database);
  if (!head) return 'empty';
  // A bucket with no history starts from a full copy, not from where the
  // uploads to another bucket stopped.
  if (seed) rmSync(bookkeeping(database), { recursive: true, force: true });
  const uploaded = await replicate({
    database,
    bucket: context.bucket,
    run: context.run,
  });
  const remote: Remote = uploaded
    ? await fetchRemote(context)
    : { status: 'unreachable' };
  if (remote.status === 'present') discard(remote.file);
  if (remote.status !== 'present' || remote.head.id !== head.id)
    return 'unreachable';
  saveReplicated(context.root, context.bucket, head);
  return 'in-sync';
}

/** After a change made on top of `before`: uploads it when there is a bucket
 * to upload to and this copy differs from what the bucket last matched.
 */
function settle(context: StateContext, before: Standing): Promise<Standing> {
  const { bucket } = context;
  // A damaged replica keeps its history for a point-in-time restore.
  if (!bucket || before === 'unreachable' || before === 'corrupt')
    return Promise.resolve(before);
  const head = readHead(databasePath(context.root));
  if (
    before === 'in-sync' &&
    readReplicated(context.root, bucket)?.head === head?.id
  )
    return Promise.resolve('in-sync');
  return upload(
    { ...context, bucket },
    before === 'empty' || before === 'unpublished'
  );
}

/** Read-only: compares this copy with the bucket and changes neither. */
export function standing(context: StateContext): Promise<Standing> {
  return locked(context.root, async () => {
    const observation = await observe(context, false);
    if (observation.remote?.status === 'present')
      discard(observation.remote.file);
    return observation.standing;
  });
}

export interface Refreshed {
  standing: Standing;
  /** This copy was stale and is now the bucket's version. */
  replaced: boolean;
}

/** Brings this copy up to the bucket before it is read or changed. Never
 * uploads, and never replaces a copy that has changes of its own.
 */
export function refresh(context: StateContext): Promise<Refreshed> {
  return locked(context.root, async () => {
    const database = databasePath(context.root);
    const before = readHead(database)?.id;
    const standing = await observed(context, false);
    return { standing, replaced: readHead(database)?.id !== before };
  });
}

/** True when this copy has changes the bucket is not known to hold. Reads
 * local files only.
 */
export function pending(context: StateContext): boolean {
  const head = readHead(databasePath(context.root));
  return Boolean(
    context.bucket &&
    head &&
    readReplicated(context.root, context.bucket)?.head !== head.id
  );
}

/** Replaces this copy with the bucket's version, whatever this copy holds. */
export function pull(context: StateContext): Promise<Standing> {
  return locked(context.root, () => observed(context, true));
}

/** Replaces this copy with the version the bucket held at `timestamp`, then
 * uploads it as the bucket's current version: the way back from a replica
 * whose latest version is damaged. `unreachable` when the bucket holds no
 * readable version at that time.
 */
export function pullAt(
  context: StateContext,
  timestamp: string
): Promise<Standing> {
  if (Number.isNaN(Date.parse(timestamp)))
    throw new FleetUsageError(
      '--timestamp needs a time such as 2026-11-01T00:00:00Z.'
    );
  const { bucket } = context;
  if (!bucket)
    throw new FleetUsageError(
      'No bucket is configured, so there is no earlier version to restore.'
    );
  return locked(context.root, async () => {
    const remote = await fetchRemote(
      { ...context, bucket },
      true,
      new Date(timestamp).toISOString()
    );
    if (remote.status !== 'present')
      return remote.status === 'absent' ? 'empty' : remote.status;
    const database = databasePath(context.root);
    discard(database);
    renameSync(remote.file, database);
    chmodSync(database, 0o600);
    return upload({ ...context, bucket }, true);
  });
}

/** Uploads this copy's changes, only when the bucket has not moved since
 * this copy last matched it. A copy with no changes of its own is brought up
 * to the bucket instead; a diverged one is left alone and reported.
 */
export function push(context: StateContext): Promise<Standing> {
  return locked(context.root, async () => {
    const before = await observed(context, false);
    return ['unpublished', 'local-ahead'].includes(before)
      ? settle(context, before)
      : before;
  });
}

/** How long a manager holds the lease after its last change. A machine that
 * wakes up later than this may take it without being asked.
 */
export const LEASE_DAYS = 7;
const LEASE_MS = LEASE_DAYS * 24 * 60 * 60 * 1000;

/** Another manager holds the lease: this one changes nothing. */
export class LeaseHeldError extends FleetUsageError {}

/** The lease another manager holds over this copy, when it is not expired
 * and this machine was not told to take it over. Reads local files only: call
 * it on the bucket's version, after a refresh.
 */
export function leaseConflict(
  context: StateContext,
  now: Date = (context.now ?? (() => new Date()))()
): Lease | null {
  const lease = readLease(databasePath(context.root));
  if (!context.holder || !lease || lease.holder === context.holder) return null;
  if (Date.parse(lease.expiresAt) <= now.getTime() || context.takeOver)
    return null;
  return lease;
}

export function leaseHeldMessage(lease: Lease): string {
  return `FLEET_MANAGER_LEASE_HELD: another manager (${lease.holder}) holds the fleet state until ${lease.expiresAt}. Nothing was changed. Run devfleet from that manager; to make this machine the manager instead, repeat with --take-over once the other one is gone (see docs/manager-recovery.md).`;
}

/** Refuses when another manager holds the lease. Call it before the first
 * write of a session.
 */
export function refuseHeldLease(context: StateContext): void {
  const held = leaseConflict(context);
  if (held) throw new LeaseHeldError(leaseHeldMessage(held));
}

/** Takes or renews the lease for this machine: when it is not this machine's
 * yet, or half spent. Call it at the end of a session that may write.
 */
export function claimLease(
  context: StateContext,
  now: Date = (context.now ?? (() => new Date()))()
): void {
  refuseHeldLease(context);
  if (!context.holder) return;
  const lease = readLease(databasePath(context.root));
  const fresh =
    lease?.holder === context.holder &&
    Date.parse(lease.expiresAt) - now.getTime() > LEASE_MS / 2;
  if (fresh) return;
  writeLease(databasePath(context.root), {
    holder: context.holder,
    expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
  });
}

export const DIVERGED_REMEDY =
  'This machine and the bucket both changed the fleet state. The bucket is the source of truth: keep a copy of anything you still need (devfleet fleet-state --export), then run devfleet fleet-state --restore --yes.';

/** Makes one change on top of the bucket's current version and uploads it.
 * A bucket that cannot be reached does not stop the change: this copy stays
 * ahead and the next change, or `fleet-state --push`, uploads it.
 */
export function mutateState<T>(
  context: StateContext,
  change: (before: Standing) => T | Promise<T>
): Promise<{ value: T; standing: Standing }> {
  return locked(context.root, async () => {
    const before = await observed(context, false);
    if (before === 'diverged') throw new FleetUsageError(DIVERGED_REMEDY);
    refuseHeldLease(context);
    const value = await change(before);
    claimLease(context);
    return { value, standing: await settle(context, before) };
  });
}
