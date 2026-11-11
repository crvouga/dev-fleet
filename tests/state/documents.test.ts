import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runRecord } from '../../src/cli/fleet-sync-state';
import { addNode, loadRoster, readRoster } from '../../src/cli/roster';
import { resolveSettings } from '../../src/cli/settings';
import { parseBucket } from '../../src/state/bucket';
import { loadEnrollment, storeEnrollment } from '../../src/state/enrollment';
import { adoptEarlier, legacyPath, readLegacy } from '../../src/state/legacy';
import { databasePath, stateRoot } from '../../src/state/paths';
import {
  STATE_ROSTER,
  readRosterText,
  writeRosterText,
} from '../../src/state/roster';
import { readDocument } from '../../src/state/store';
import { refresh, type StateContext } from '../../src/state/sync';
import { NODE } from '../../src/test-fixtures';
import { fakeLitestream } from './litestream-fake';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'fleet-documents-'));
  roots.push(path);
  return path;
}
const REVISION = 'a'.repeat(40);
const ROSTER = JSON.stringify({
  version: 1,
  nodes: [{ id: 'worker-one', ssh: 'worker-one', workspace: '/' }],
});

test('the roster is kept in the fleet state unless a file is named', async () => {
  const directory = await home();
  expect(
    (await resolveSettings({}, directory, { PERSONAL_WORKSPACE: directory }))
      .config
  ).toBe(STATE_ROSTER);
  expect(
    (
      await resolveSettings({ config: STATE_ROSTER }, directory, {
        PERSONAL_WORKSPACE: directory,
      })
    ).config
  ).toBe(STATE_ROSTER);
  const named = join(directory, 'roster.json');
  expect(
    (
      await resolveSettings({ config: named }, directory, {
        PERSONAL_WORKSPACE: directory,
      })
    ).config
  ).toBe(named);
  writeFileSync(join(directory, '.fleet.local.json'), ROSTER);
  expect(
    (await resolveSettings({}, directory, { PERSONAL_WORKSPACE: directory }))
      .config
  ).toBe(join(directory, '.fleet.local.json'));
});

test('fleet-node-add writes the state roster and reports how it stands with the bucket', async () => {
  // The test process has its own empty state directory and no bucket.
  expect(await readRoster(STATE_ROSTER)).toBeNull();
  await expect(loadRoster(STATE_ROSTER)).rejects.toThrow(
    'Cannot read fleet config'
  );
  const preview = await addNode(STATE_ROSTER, NODE, false);
  expect(preview.roster.nodes).toHaveLength(1);
  expect(await readRoster(STATE_ROSTER)).toBeNull();
  const directory = await home();
  const remote = join(directory, 'remote');
  const context = (): StateContext => ({
    root: stateRoot(),
    bucket: parseBucket({ directory: remote }),
    run: fakeLitestream(remote).run,
  });
  try {
    const added = await addNode(STATE_ROSTER, NODE, true, context);
    expect(added.standing).toBe('in-sync');
    expect(
      (await loadRoster(STATE_ROSTER)).nodes.map((node) => node.id)
    ).toEqual([NODE.id]);
    await expect(addNode(STATE_ROSTER, NODE, true, context)).rejects.toThrow(
      'unique'
    );
  } finally {
    await rm(stateRoot(), { recursive: true, force: true });
  }
});

test('earlier files are read until the machine has a state, then moved all at once', async () => {
  const directory = await home();
  const env = {};
  const database = databasePath(stateRoot(env, directory));
  const write = (
    name: 'roster' | 'enrollment' | 'definition',
    text: string
  ) => {
    const path = legacyPath(name, env, directory)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write('roster', ROSTER);
  write('enrollment', 'not json');
  expect(await readRosterText(STATE_ROSTER, env, directory)).toBe(ROSTER);
  expect(existsSync(database)).toBe(false);
  // The first change creates the database with every valid earlier document,
  // so the roster does not vanish when something else is written first.
  const next = ROSTER.replace('worker-one', 'worker-two');
  await writeRosterText(STATE_ROSTER, next, env, directory);
  expect(readDocument(database, 'roster')).toBe(next);
  expect(readDocument(database, 'enrollment')).toBeNull();
  // From now on the state is the only place read.
  expect(readLegacy('roster', env, directory)).toBeNull();
  expect(adoptEarlier(env, directory)).toEqual([]);
  expect(readFileSync(legacyPath('roster', env, directory)!, 'utf8')).toBe(
    ROSTER
  );
  // A state directory named explicitly is another fleet's.
  expect(
    legacyPath('roster', { DEVFLEET_STATE: '/elsewhere' }, directory)
  ).toBe(null);
});

test('a configuration kept in a file of your own is not copied into the state', async () => {
  const directory = await home();
  const path = legacyPath('definition', {}, directory)!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    readFileSync(join(import.meta.dir, '../../examples/fleet.json'), 'utf8')
  );
  expect(
    adoptEarlier({ DEVFLEET_CONFIG: '/repo/fleet.json' }, directory)
  ).toEqual([]);
  expect(adoptEarlier({}, directory)).toEqual(['definition']);
});

test('the approved revision moves from its earlier file into the state', async () => {
  const directory = await home();
  const env = { DEVFLEET_STATE: join(directory, 'state') };
  const earlier = join(directory, 'manager');
  mkdirSync(earlier);
  writeFileSync(
    join(earlier, 'enrollment.json'),
    JSON.stringify({ version: 1, id: 'manager', approvedRevision: REVISION })
  );
  expect((await loadEnrollment(earlier, env))?.approvedRevision).toBe(REVISION);
  expect(await loadEnrollment(null, env)).toBeNull();
  storeEnrollment(
    { version: 1, id: 'manager', approvedRevision: 'b'.repeat(40) },
    env
  );
  expect((await loadEnrollment(earlier, env))?.approvedRevision).toBe(
    'b'.repeat(40)
  );
  const database = databasePath(env.DEVFLEET_STATE);
  const { writeDocument } = await import('../../src/state/store');
  writeDocument(database, 'enrollment', '{"version":1}');
  await expect(loadEnrollment(earlier, env)).rejects.toThrow(
    'fleet-state --restore'
  );
});

test('a fleet-sync run records its approval and result, and the report says whether the bucket has them', async () => {
  const directory = await home();
  const env = { DEVFLEET_STATE: join(directory, 'state') };
  const remote = join(directory, 'remote');
  const bucket = fakeLitestream(remote);
  const context: StateContext = {
    root: env.DEVFLEET_STATE,
    bucket: parseBucket({ directory: remote }),
    run: bucket.run,
  };
  const start = async () => (await refresh(context)).standing;

  // A run that fails leaves its approval, and the bucket still receives it.
  const failed = runRecord(null, REVISION, {
    context,
    standing: await start(),
    env,
  });
  failed.approve();
  expect(await failed.settle(false)).toMatchObject({
    id: 'state:replica',
    status: 'pass',
  });
  let stored = await loadEnrollment(null, env);
  expect(stored).toEqual({
    version: 1,
    id: 'manager',
    approvedRevision: REVISION,
  });

  // A run that converges records what it applied and what it replaced.
  const next = 'b'.repeat(40);
  const first = runRecord(stored, REVISION, {
    context,
    standing: await start(),
    env,
  });
  first.approve();
  await first.settle(true);
  stored = await loadEnrollment(null, env);
  const second = runRecord(stored, next, {
    context,
    standing: await start(),
    env,
  });
  second.approve();
  // The bucket going away never fails the run: it is reported as a warning.
  bucket.down = true;
  expect(await second.settle(true)).toMatchObject({
    id: 'state:replica',
    status: 'warn',
  });
  expect(await loadEnrollment(null, env)).toEqual({
    version: 1,
    id: 'manager',
    approvedRevision: next,
    appliedRevision: next,
    previousRevision: REVISION,
  });
  // The next run starts ahead of the bucket and uploads both changes.
  bucket.down = false;
  expect(await start()).toBe('local-ahead');
  const repeat = runRecord(await loadEnrollment(null, env), next, {
    context,
    standing: 'local-ahead',
    env,
  });
  repeat.approve();
  expect((await repeat.settle(true)).status).toBe('pass');
  // Repeating a converged run changes nothing and uploads nothing.
  const calls = bucket.calls.length;
  const idle = runRecord(await loadEnrollment(null, env), next, {
    context,
    standing: await start(),
    env,
  });
  const fetched = bucket.calls.length - calls;
  idle.approve();
  expect((await idle.settle(true)).status).toBe('pass');
  expect(bucket.calls.length - calls).toBe(fetched);
});

test('a run that stops before its report still uploads its approval', async () => {
  const directory = await home();
  const env = { DEVFLEET_STATE: join(directory, 'state') };
  const remote = join(directory, 'remote');
  const context: StateContext = {
    root: env.DEVFLEET_STATE,
    bucket: parseBucket({ directory: remote }),
    run: fakeLitestream(remote).run,
  };
  const record = runRecord(null, REVISION, { context, standing: 'empty', env });
  record.approve();
  await record.abandon();
  expect((await refresh(context)).standing).toBe('in-sync');
  const other: StateContext = { ...context, root: join(directory, 'other') };
  await refresh(other);
  expect(readDocument(databasePath(other.root), 'enrollment')).toContain(
    REVISION
  );
});
