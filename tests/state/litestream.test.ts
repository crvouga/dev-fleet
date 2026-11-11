import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCommand } from '../../src/runner';
import { parseBucket } from '../../src/state/bucket';
import { databasePath } from '../../src/state/paths';
import { readDocument, writeDocument } from '../../src/state/store';
import {
  mutateState,
  pull,
  refresh,
  standing,
  type StateContext,
} from '../../src/state/sync';

// The pinned Litestream itself, replicating to a directory: no network and no
// machine. Skipped where the toolchain is not installed (plain CI runners).
const installed =
  spawnSync('mise', ['which', 'litestream'], {
    cwd: resolve(import.meta.dir, '../..'),
    stdio: 'ignore',
  }).status === 0;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test.skipIf(!installed)(
  'Litestream replicates the state database and a new manager restores it',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-litestream-'));
    roots.push(root);
    const bucket = parseBucket({ directory: join(root, 'remote') });
    const manager = (name: string): StateContext => ({
      root: join(root, name),
      bucket,
      run: runCommand,
    });
    const [a, b] = [manager('a'), manager('b')];
    const body = (context: StateContext) =>
      readDocument(databasePath(context.root), 'definition');

    expect(await standing(a)).toBe('empty');
    for (const text of ['one', 'two', 'three'])
      expect(
        await mutateState(a, () =>
          writeDocument(databasePath(a.root), 'definition', text)
        )
      ).toMatchObject({ standing: 'in-sync' });

    // A machine that has never seen the fleet gets all of it from the bucket.
    expect(await refresh(b)).toEqual({ standing: 'in-sync', replaced: true });
    expect(body(b)).toBe('three');

    // It continues the same history, and the first machine follows it.
    expect(
      await mutateState(b, () =>
        writeDocument(databasePath(b.root), 'definition', 'four')
      )
    ).toMatchObject({ standing: 'in-sync' });
    expect(await standing(a)).toBe('bucket-ahead');
    expect(await pull(a)).toBe('in-sync');
    expect(body(a)).toBe('four');
    expect(
      await mutateState(a, () =>
        writeDocument(databasePath(a.root), 'definition', 'five')
      )
    ).toMatchObject({ standing: 'in-sync' });
    expect((await refresh(b)).replaced).toBe(true);
    expect(body(b)).toBe('five');
  },
  60_000
);
