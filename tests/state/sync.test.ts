import { afterEach, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBucket } from '../../src/state/bucket';
import { databasePath } from '../../src/state/paths';
import { readDocument, writeDocument } from '../../src/state/store';
import {
  mutateState,
  pending,
  pull,
  push,
  refresh,
  standing,
  type StateContext,
} from '../../src/state/sync';
import { fakeLitestream, type FakeLitestream } from './litestream-fake';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/** Two managers that replicate to one bucket, as after replacing a machine. */
async function fleet(): Promise<{
  a: StateContext;
  b: StateContext;
  bucket: FakeLitestream;
  remote: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'fleet-sync-'));
  roots.push(root);
  const remote = join(root, 'remote');
  const bucket = fakeLitestream(remote);
  const target = parseBucket({ directory: remote });
  const manager = (name: string): StateContext => ({
    root: join(root, name),
    bucket: target,
    run: bucket.run,
  });
  return { a: manager('a'), b: manager('b'), bucket, remote };
}

const write = (context: StateContext, body: string) =>
  writeDocument(databasePath(context.root), 'definition', body);
const read = (context: StateContext) =>
  readDocument(databasePath(context.root), 'definition');

test('without a bucket the state is local only and nothing is ever run', async () => {
  const { a, bucket } = await fleet();
  const local = { ...a, bucket: null };
  expect(await standing(local)).toBe('local-only');
  const changed = await mutateState(local, () => write(local, 'one'));
  expect(changed.standing).toBe('local-only');
  expect(read(local)).toBe('one');
  expect(pending(local)).toBe(false);
  expect(await push(local)).toBe('local-only');
  expect(bucket.calls).toHaveLength(0);
});

test('a change is uploaded, then read back from the bucket before it counts', async () => {
  const { a, bucket } = await fleet();
  expect(await standing(a)).toBe('empty');
  const changed = await mutateState(a, () => write(a, 'one'));
  expect(changed.standing).toBe('in-sync');
  expect(pending(a)).toBe(false);
  expect(await standing(a)).toBe('in-sync');
  // An upload that reports success but stored nothing is not believed.
  bucket.lossy = true;
  expect((await mutateState(a, () => write(a, 'two'))).standing).toBe(
    'unreachable'
  );
  expect(pending(a)).toBe(true);
  bucket.lossy = false;
  expect(await standing(a)).toBe('local-ahead');
  expect(await push(a)).toBe('in-sync');
});

test('a new manager restores the state and a stale one is replaced before it changes anything', async () => {
  const { a, b } = await fleet();
  await mutateState(a, () => write(a, 'from a'));
  // B is a fresh machine: local data is disposable, the bucket is the truth.
  expect(await standing(b)).toBe('bucket-ahead');
  expect(await refresh(b)).toEqual({ standing: 'in-sync', replaced: true });
  expect(read(b)).toBe('from a');
  expect(await refresh(b)).toEqual({ standing: 'in-sync', replaced: false });
  await mutateState(b, () => write(b, 'from b'));
  // A never saw B's change. Its next change starts from B's version.
  expect(await standing(a)).toBe('bucket-ahead');
  const changed = await mutateState(a, (before) => {
    expect(before).toBe('in-sync');
    expect(read(a)).toBe('from b');
    return writeDocument(databasePath(a.root), 'roster', 'a roster');
  });
  expect(changed.standing).toBe('in-sync');
  await refresh(b);
  expect(readDocument(databasePath(b.root), 'roster')).toBe('a roster');
  expect(read(b)).toBe('from b');
});

test('an unreachable bucket does not stop a change, and the next command uploads it', async () => {
  const { a, bucket } = await fleet();
  await mutateState(a, () => write(a, 'one'));
  bucket.down = true;
  expect(await standing(a)).toBe('unreachable');
  const offline = await mutateState(a, () => write(a, 'two'));
  expect(offline.standing).toBe('unreachable');
  expect(read(a)).toBe('two');
  expect(pending(a)).toBe(true);
  bucket.down = false;
  expect(await standing(a)).toBe('local-ahead');
  // A refresh never replaces a copy that has changes of its own.
  expect(await refresh(a)).toEqual({
    standing: 'local-ahead',
    replaced: false,
  });
  const next = await mutateState(a, () =>
    writeDocument(databasePath(a.root), 'roster', 'r')
  );
  expect(next.standing).toBe('in-sync');
  expect(pending(a)).toBe(false);
});

test('two managers that both changed the state diverge, and only the bucket wins', async () => {
  const { a, b, bucket } = await fleet();
  await mutateState(a, () => write(a, 'base'));
  await refresh(b);
  bucket.down = true;
  await mutateState(b, () => write(b, 'offline on b'));
  bucket.down = false;
  await mutateState(a, () => write(a, 'online on a'));
  expect(await standing(b)).toBe('diverged');
  expect(await push(b)).toBe('diverged');
  expect((await refresh(b)).standing).toBe('diverged');
  await expect(mutateState(b, () => write(b, 'more'))).rejects.toThrow(
    'fleet-state --restore --yes'
  );
  expect(read(b)).toBe('offline on b');
  // Nothing of B's reached the bucket.
  await refresh(a);
  expect(read(a)).toBe('online on a');
  expect(await pull(b)).toBe('in-sync');
  expect(read(b)).toBe('online on a');
  expect(pending(b)).toBe(false);
});

test('a copy that matched another bucket does not pass for this one', async () => {
  const { a, bucket, remote } = await fleet();
  await mutateState(a, () => write(a, 'one'));
  const moved: StateContext = {
    ...a,
    bucket: parseBucket({ directory: `${remote}-other` }),
    run: fakeLitestream(`${remote}-other`).run,
  };
  // The new bucket is empty: this copy seeds it rather than counting as
  // already uploaded.
  expect(pending(moved)).toBe(true);
  expect(await standing(moved)).toBe('unpublished');
  expect(await push(moved)).toBe('in-sync');
  expect(bucket.calls.length).toBeGreaterThan(0);
});

test('downloads never outlive the command that made them', async () => {
  const { a, b } = await fleet();
  await mutateState(a, () => write(a, 'one'));
  await standing(b);
  await refresh(b);
  await standing(a);
  await push(a);
  for (const context of [a, b]) {
    const left = readdirSync(context.root).filter((name) =>
      name.startsWith('incoming-')
    );
    expect(left).toEqual([]);
    expect(existsSync(join(context.root, 'sync.lock'))).toBe(false);
  }
});

test('the bucket credentials reach Litestream through its environment only', async () => {
  const { a, bucket } = await fleet();
  const secret = 'secret/example+key';
  const s3: StateContext = {
    ...a,
    bucket: parseBucket({
      bucket: 'fleet-state',
      endpoint: 'https://s3.example.com',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: secret,
    }),
  };
  await mutateState(s3, () => write(s3, 'one'));
  expect(bucket.calls.length).toBeGreaterThan(1);
  for (const call of bucket.calls) {
    expect(call.argv.join(' ')).not.toContain(secret);
    expect(call.argv[0]).toBe('/pinned/litestream');
    expect(call.argv).toContain('-no-expand-env');
    expect(call.env['AWS_SECRET_ACCESS_KEY']).toBe(secret);
  }
});

test('the pinned Litestream is installed by a change, never by the read-only comparison', async () => {
  const { a } = await fleet();
  const commands: string[][] = [];
  let installed = false;
  const run: StateContext['run'] = async (argv) => {
    commands.push(argv);
    if (argv[1] === 'install') installed = true;
    return {
      ok: argv[1] === 'install' || (argv[1] === 'which' && installed),
      stdout: '/pinned/litestream\n',
      stderr: '',
      reason: 'exit',
    };
  };
  const missing = { ...a, run };
  expect(await standing(missing)).toBe('unreachable');
  expect(commands).toEqual([['mise', 'which', 'litestream']]);
  await mutateState(missing, () => write(missing, 'one'));
  expect(commands).toContainEqual(['mise', 'install', 'litestream']);
});
