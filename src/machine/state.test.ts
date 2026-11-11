import { afterEach, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  utimes,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnrollment, saveEnrollment, withMachineLock } from './state';
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
test('manager state saves an exact approved revision without fabricating application success', async () => {
  const directory = await root();
  expect(await readEnrollment(directory)).toBeNull();
  await saveEnrollment(directory, {
    version: 1,
    id: 'manager',
    approvedRevision: 'a'.repeat(40),
  });
  expect((await readEnrollment(directory))?.appliedRevision).toBeUndefined();
  expect(
    await readFile(join(directory, 'enrollment.json'), 'utf8')
  ).not.toContain('token');
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
