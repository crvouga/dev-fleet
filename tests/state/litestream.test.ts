import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fleetState, type FleetStateServices } from '../../src/cli/fleet-state';
import { runCommand } from '../../src/runner';
import { parseBucket } from '../../src/state/bucket';
import { bucketPath, databasePath, stateRoot } from '../../src/state/paths';
import { readDocument, writeDocument } from '../../src/state/store';
import {
  mutateState,
  pull,
  refresh,
  standing,
  type StateContext,
} from '../../src/state/sync';

// The pinned Litestream itself, replicating to a directory and to an S3 API:
// no machine and no real bucket. Skipped where the toolchain is not installed
// (the plain Check job); the Fleet state job in CI installs it and sets
// DEVFLEET_TEST_LITESTREAM=required, so there a missing piece fails instead.
const installed =
  spawnSync('mise', ['which', 'litestream'], {
    cwd: resolve(import.meta.dir, '../..'),
    stdio: 'ignore',
  }).status === 0;
const required = process.env['DEVFLEET_TEST_LITESTREAM'] === 'required';
/** The origin of a throwaway S3 service, such as http://127.0.0.1:5000. */
const s3 = process.env['DEVFLEET_TEST_S3'];
const EXAMPLE = resolve(import.meta.dir, '../../examples/fleet.json');

test.skipIf(!required)(
  'where these checks are required, nothing they need is missing',
  () => {
    expect(installed).toBe(true);
    expect(s3).toBeTruthy();
  }
);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test.skipIf(!installed && !required)(
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

test.skipIf((!installed || !s3) && !required)(
  'fleet-state keeps a fleet in an S3 bucket and a replacement manager restores it',
  async () => {
    const bucket = `fleet-state-${Date.now().toString(36)}`;
    expect((await fetch(`${s3}/${bucket}`, { method: 'PUT' })).ok).toBe(true);
    const secret = 'test-secret-access-key';
    const manager = async (): Promise<FleetStateServices> => {
      const home = await mkdtemp(join(tmpdir(), 'fleet-s3-'));
      roots.push(home);
      return {
        run: runCommand,
        env: {
          DEVFLEET_BUCKET_ACCESS_KEY_ID: 'test-access-key-id',
          DEVFLEET_BUCKET_SECRET_ACCESS_KEY: secret,
        },
        home,
        ask: null,
      };
    };
    const connect = {
      init: true,
      bucket,
      endpoint: s3!,
      region: 'us-east-1',
      prefix: 'fleets/one',
    };

    const first = await manager();
    expect((await fleetState(connect, first)).exitCode).toBe(0);
    const stored = await fleetState({ import: EXAMPLE }, first);
    expect(stored.data).toMatchObject({ standing: 'in-sync', ok: true });
    // The database is in the bucket, under this fleet's prefix only.
    const listing = await (await fetch(`${s3}/${bucket}?list-type=2`)).text();
    const keys = [...listing.matchAll(/<Key>([^<]+)<\/Key>/g)].map(
      (match) => match[1]!
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('fleets/one/fleet.db/'))).toBe(
      true
    );
    // The keys are kept in bucket.json alone.
    const root = stateRoot(first.env, first.home);
    expect(readFileSync(join(root, 'litestream.yml'), 'utf8')).not.toContain(
      secret
    );
    expect(readFileSync(bucketPath(first.env, first.home), 'utf8')).toContain(
      secret
    );
    expect(JSON.stringify(stored)).not.toContain(secret);

    // A replacement manager brings only the bucket's location and keys.
    const second = await manager();
    const restored = await fleetState(connect, second);
    expect(restored.exitCode).toBe(0);
    expect(restored.text).toContain(
      'Restored the fleet state from the bucket.'
    );
    const exported = await fleetState({ export: true }, second);
    expect(JSON.parse(exported.text!)).toEqual(
      JSON.parse(readDocument(databasePath(root), 'definition')!)
    );

    // It changes the fleet; the first manager notices and follows.
    const edited = join(second.home, 'edited.json');
    writeFileSync(
      edited,
      exported.text!.replaceAll('worker-two', 'worker-renamed')
    );
    expect((await fleetState({ import: edited }, second)).data).toMatchObject({
      standing: 'in-sync',
    });
    expect((await fleetState({}, first)).data).toMatchObject({
      standing: 'bucket-ahead',
    });
    expect((await fleetState({ restore: true }, first)).data).toMatchObject({
      standing: 'in-sync',
    });
    expect(readDocument(databasePath(root), 'definition')).toContain(
      'worker-renamed'
    );
  },
  120_000
);
