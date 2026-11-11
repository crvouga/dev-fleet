import { afterEach, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  utimes,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnrollment, withMachineLock } from './state';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'manager-state-'));
  roots.push(path);
  return path;
}
test('the earlier enrollment file is read exactly and an invalid one is refused', async () => {
  const directory = await root();
  expect(await readEnrollment(directory)).toBeNull();
  await writeFile(
    join(directory, 'enrollment.json'),
    JSON.stringify({
      version: 1,
      id: 'manager',
      approvedRevision: 'a'.repeat(40),
    })
  );
  const enrollment = await readEnrollment(directory);
  expect(enrollment?.approvedRevision).toBe('a'.repeat(40));
  expect(enrollment?.appliedRevision).toBeUndefined();
  await writeFile(join(directory, 'enrollment.json'), '{"version":1}');
  await expect(readEnrollment(directory)).rejects.toThrow('Invalid enrollment');
});
test('overlapping managers fail closed and a completed operation releases its lock', async () => {
  const directory = await root();
  await withMachineLock(directory, async () => {
    await expect(
      withMachineLock(directory, async () => 'unexpected')
    ).rejects.toThrow('locked');
  });
  expect(await withMachineLock(directory, async () => 'next')).toBe('next');
});

async function plantLock(directory: string, owner: string | null) {
  const lock = join(directory, 'sync.lock');
  await mkdir(lock);
  if (owner !== null) await writeFile(join(lock, 'owner.json'), owner);
  return lock;
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

test('a lock left by a dead process is reclaimed with its stale transfer bundle', async () => {
  const directory = await root();
  // PID 2^22 + 1 is above Linux and macOS pid ranges, so it is never alive.
  await plantLock(
    directory,
    JSON.stringify({ version: 1, pid: 4_194_305, startedAt: 'x' })
  );
  const bundle = join(directory, `transfer-${'a'.repeat(8)}-0000.bundle`);
  await writeFile(bundle, 'stale');
  expect(await withMachineLock(directory, async () => 'ran')).toBe('ran');
  expect(await exists(bundle)).toBe(false);
  expect(await exists(join(directory, 'sync.lock'))).toBe(false);
});

test('a lock owned by a live process is never stolen', async () => {
  const directory = await root();
  await plantLock(directory, JSON.stringify({ version: 1, pid: process.pid }));
  await expect(withMachineLock(directory, async () => 'no')).rejects.toThrow(
    'locked'
  );
  expect(await exists(join(directory, 'sync.lock'))).toBe(true);
});

test('an ownerless lock is held while fresh and reclaimed once abandoned', async () => {
  const directory = await root();
  const lock = await plantLock(directory, null);
  await expect(withMachineLock(directory, async () => 'no')).rejects.toThrow(
    'locked'
  );
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  expect(await withMachineLock(directory, async () => 'ran')).toBe('ran');
});
