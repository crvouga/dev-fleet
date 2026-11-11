import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managerSync, type ManagerSync } from '../../src/cli/fleet-sync';
import { parseDefinition } from '../../src/definition';
import { reloadFleet } from '../../src/fleet-config';
import { parseBucket, writeBucket } from '../../src/state/bucket';
import { loadEnrollment, storeEnrollment } from '../../src/state/enrollment';
import { STATE_ROSTER } from '../../src/state/roster';
import { databasePath } from '../../src/state/paths';
import { readDocument } from '../../src/state/store';
import {
  mutateState,
  refresh,
  standing,
  type StateContext,
} from '../../src/state/sync';
import type { Runner } from '../../src/types';
import { fakeLitestream, type FakeLitestream } from '../state/litestream-fake';

const settings = { workspace: '/no-checkout', config: STATE_ROSTER };
const REVISION = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

// A manager's home: its fleet state, its bucket settings and its run lock.
// Nothing here reaches the convergence itself: with no worker enrolled, a run
// stops at FLEET_MANAGER_ENROLLMENT_REQUIRED after it has used the state.
let home: string;
let bucket: FakeLitestream;
const saved = { ...process.env };
beforeEach(async () => {
  // The run lock refuses a path through a symbolic link, as /tmp is on macOS.
  home = await realpath(await mkdtemp(join(tmpdir(), 'fleet-sync-state-')));
  process.env['DEVFLEET_STATE'] = join(home, 'state');
  process.env['DEVFLEET_BUCKET'] = join(home, 'bucket.json');
  bucket = fakeLitestream(join(home, 'remote'));
});
afterEach(async () => {
  process.env['DEVFLEET_STATE'] = saved['DEVFLEET_STATE'];
  process.env['DEVFLEET_BUCKET'] = saved['DEVFLEET_BUCKET'];
  process.env['DEVFLEET_CONFIG'] = saved['DEVFLEET_CONFIG'];
  reloadFleet();
  await rm(home, { recursive: true, force: true });
});

/** Litestream answers; every other command is absent, as on a bare machine. */
const run: Runner = (argv, options) =>
  argv[0] === 'mise' || argv[0] === '/pinned/litestream'
    ? bucket.run(argv, options)
    : Promise.resolve({ ok: false, stdout: '', stderr: '', reason: 'missing' });

function services(restarts: { count: number }): ManagerSync {
  const self: ManagerSync = {
    run,
    root: join(home, 'manager'),
    restart: () => {
      restarts.count += 1;
      return managerSync(request, settings, self);
    },
  };
  return self;
}
const request = { revision: REVISION, json: true, nonInteractive: true };

function connect(): StateContext {
  const target = parseBucket({ directory: join(home, 'remote') });
  writeBucket(process.env['DEVFLEET_BUCKET']!, target);
  return { root: process.env['DEVFLEET_STATE']!, bucket: target, run };
}
/** Another manager of the same fleet, replicating to the same bucket. */
const other = (context: StateContext): StateContext => ({
  ...context,
  root: join(home, 'other-state'),
});
const summary = (outcome: { data: unknown }): string =>
  JSON.stringify(outcome.data);

test('without a bucket a run still records its approval in the local state', async () => {
  const restarts = { count: 0 };
  const outcome = await managerSync(request, settings, services(restarts));
  expect(outcome.exitCode).toBe(1);
  expect(summary(outcome)).toContain('FLEET_MANAGER_ENROLLMENT_REQUIRED');
  expect((await loadEnrollment(null))?.approvedRevision).toBe(REVISION);
  expect(bucket.calls).toHaveLength(0);
  expect(restarts.count).toBe(0);
});

test('a run uploads its approval even when it stops before its report', async () => {
  const context = connect();
  await managerSync(request, settings, services({ count: 0 }));
  expect(await standing(context)).toBe('in-sync');
  const replacement = other(context);
  await refresh(replacement);
  expect(readDocument(databasePath(replacement.root), 'enrollment')).toContain(
    REVISION
  );
});

test('a stale manager takes the bucket’s state and starts over before it changes anything', async () => {
  const context = connect();
  const current = other(context);
  await mutateState(current, () =>
    storeEnrollment(
      {
        version: 1,
        id: 'manager',
        approvedRevision: NEXT,
        appliedRevision: NEXT,
      },
      { DEVFLEET_STATE: current.root }
    )
  );
  const restarts = { count: 0 };
  await managerSync(request, settings, services(restarts));
  expect(restarts.count).toBe(1);
  // The run built on what the other manager applied instead of erasing it.
  expect(await loadEnrollment(null)).toEqual({
    version: 1,
    id: 'manager',
    approvedRevision: REVISION,
    appliedRevision: NEXT,
  });
  expect(await standing(context)).toBe('in-sync');
});

test('a manager whose state diverged from the bucket changes nothing', async () => {
  const context = connect();
  await managerSync(request, settings, services({ count: 0 }));
  const current = other(context);
  await refresh(current);
  bucket.down = true;
  await managerSync(
    { ...request, revision: NEXT },
    settings,
    services({ count: 0 })
  );
  bucket.down = false;
  await mutateState(current, () =>
    storeEnrollment(
      { version: 1, id: 'manager', approvedRevision: 'c'.repeat(40) },
      { DEVFLEET_STATE: current.root }
    )
  );
  const before = readDocument(databasePath(context.root), 'enrollment');
  const outcome = await managerSync(
    { ...request, revision: 'd'.repeat(40) },
    settings,
    services({ count: 0 })
  );
  expect(outcome.exitCode).toBe(1);
  expect(summary(outcome)).toContain('FLEET_STATE_DIVERGED');
  expect(summary(outcome)).toContain('fleet-state --restore --yes');
  expect(readDocument(databasePath(context.root), 'enrollment')).toBe(before);
  expect(await standing(context)).toBe('diverged');
});

test('a preview reads the local copy and never contacts the bucket', async () => {
  connect();
  const outcome = await managerSync(
    { ...request, dryRun: true },
    settings,
    services({ count: 0 })
  );
  expect(outcome.exitCode).toBe(1);
  expect(bucket.calls).toHaveLength(0);
  expect(await loadEnrollment(null)).toBeNull();
});

test('a run from a project replicates to the bucket its fleet.json names and records the configuration it applied', async () => {
  // The project's file, with the bucket named in it. Nothing is saved on the
  // manager: no bucket.json.
  const example = JSON.parse(
    readFileSync(saved['DEVFLEET_CONFIG']!, 'utf8')
  ) as Record<string, unknown>;
  const project = join(home, 'fleet.json');
  const declared = { ...example, state: { directory: join(home, 'remote') } };
  writeFileSync(project, JSON.stringify(declared));
  process.env['DEVFLEET_CONFIG'] = project;
  reloadFleet();
  await managerSync(request, settings, services({ count: 0 }));
  expect(bucket.calls.length).toBeGreaterThan(0);
  // A replacement manager, or a run started outside the project (the
  // schedule, a hand-off from a worker), finds what was applied.
  const replacement: StateContext = {
    root: join(home, 'other-state'),
    bucket: parseBucket({ directory: join(home, 'remote') }),
    run,
  };
  expect((await refresh(replacement)).standing).toBe('in-sync');
  const recorded = readDocument(databasePath(replacement.root), 'definition');
  expect(JSON.parse(recorded!)).toEqual(parseDefinition(declared));
  expect(readDocument(databasePath(replacement.root), 'enrollment')).toContain(
    REVISION
  );
});
