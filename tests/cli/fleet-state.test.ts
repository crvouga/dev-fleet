import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execute } from '../../src/cli/program';
import { fleetState, type FleetStateServices } from '../../src/cli/fleet-state';
import { legacyPath } from '../../src/state/legacy';
import { bucketPath, databasePath, stateRoot } from '../../src/state/paths';
import { readDocument } from '../../src/state/store';
import { fakeLitestream, type FakeLitestream } from '../state/litestream-fake';

// The example fleet without the bucket it names (tests/setup.ts).
const EXAMPLE = process.env['DEVFLEET_CONFIG']!;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/** One manager's home directory and the bucket it replicates to. */
async function manager(remote?: string): Promise<{
  services: FleetStateServices;
  bucket: FakeLitestream;
  remote: string;
  database: string;
}> {
  const home = await mkdtemp(join(tmpdir(), 'fleet-state-cli-'));
  roots.push(home);
  const target = remote ?? join(home, 'remote');
  const bucket = fakeLitestream(target);
  const services = { run: bucket.run, env: {}, home, ask: null };
  return {
    services,
    bucket,
    remote: target,
    database: databasePath(stateRoot({}, home)),
  };
}

const checks = (data: unknown): Record<string, string> =>
  Object.fromEntries(
    (
      data as { nodes: [{ checks: { id: string; status: string }[] }] }
    ).nodes[0].checks.map((check) => [check.id, check.status])
  );

test('with nothing set up the status is read-only and says what to do first', async () => {
  const { services, bucket } = await manager();
  const result = await fleetState({}, services);
  expect(result.exitCode).toBe(1);
  expect(checks(result.data)).toEqual({
    'state:bucket': 'warn',
    'state:replica': 'warn',
    'state:definition': 'fail',
    'state:roster': 'skip',
    'state:enrollment': 'skip',
  });
  expect(result.data).toMatchObject({
    command: 'fleet-state',
    standing: 'local-only',
    bucket: { configured: false },
  });
  expect(result.text).toContain('fleet-state --init --bucket');
  expect(bucket.calls).toHaveLength(0);
  expect(existsSync(bucketPath({}, services.home))).toBe(false);
});

test('a new fleet connects a bucket, stores its configuration and a second manager restores it', async () => {
  const first = await manager();
  const connected = await fleetState(
    { init: true, directory: first.remote },
    first.services
  );
  // An empty bucket is connected; the configuration is the next step.
  expect(connected.exitCode).toBe(0);
  expect(checks(connected.data)['state:definition']).toBe('warn');
  const stored = await fleetState({ import: EXAMPLE }, first.services);
  expect(stored.exitCode).toBe(0);
  expect(stored.data).toMatchObject({ standing: 'in-sync', ok: true });
  expect(checks(stored.data)).toMatchObject({
    'state:bucket': 'pass',
    'state:replica': 'pass',
    'state:definition': 'pass',
  });

  // Another machine has only the bucket's location and its credentials.
  const second = await manager(first.remote);
  const restored = await fleetState(
    { init: true, directory: first.remote },
    second.services
  );
  expect(restored.exitCode).toBe(0);
  expect(restored.text).toContain('Restored the fleet state from the bucket.');
  const exported = await fleetState({ export: true }, second.services);
  expect(JSON.parse(exported.text!)).toEqual(
    JSON.parse(readDocument(first.database, 'definition')!)
  );
  expect((exported.data as { definition: unknown }).definition).toMatchObject({
    version: 3,
    manager: { id: 'manager-mac' },
  });
});

test('init moves what an existing manager kept in files into the state and seeds the bucket', async () => {
  const { services, remote, database } = await manager();
  const earlier = {
    definition: readFileSync(EXAMPLE, 'utf8'),
    roster: JSON.stringify({
      version: 1,
      nodes: [{ id: 'worker-one', ssh: 'worker-one', workspace: '/' }],
    }),
    enrollment: JSON.stringify({
      version: 1,
      id: 'manager',
      approvedRevision: 'a'.repeat(40),
    }),
  };
  for (const [name, text] of Object.entries(earlier)) {
    const path = legacyPath(name as keyof typeof earlier, {}, services.home)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const before = await fleetState({}, services);
  expect(checks(before.data)).toMatchObject({
    'state:definition': 'warn',
    'state:roster': 'warn',
    'state:enrollment': 'warn',
  });
  const result = await fleetState({ init: true, directory: remote }, services);
  expect(result.exitCode).toBe(0);
  expect(result.text).toContain('definition, roster, enrollment');
  expect(result.data).toMatchObject({ standing: 'in-sync' });
  expect(readDocument(database, 'enrollment')).toBe(earlier.enrollment);
  expect(readDocument(database, 'roster')).toBe(earlier.roster);
  // The earlier files are left alone, and a second init changes nothing.
  expect(readFileSync(legacyPath('roster', {}, services.home)!, 'utf8')).toBe(
    earlier.roster
  );
  const again = await fleetState({ init: true }, services);
  expect(again.text).not.toContain('Moved into the fleet state');
});

test('a bucket that already holds the fleet is never overwritten from earlier files', async () => {
  const first = await manager();
  await fleetState({ init: true, directory: first.remote }, first.services);
  await fleetState({ import: EXAMPLE }, first.services);
  const second = await manager(first.remote);
  const stale = legacyPath('enrollment', {}, second.services.home)!;
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(
    stale,
    JSON.stringify({
      version: 1,
      id: 'manager',
      approvedRevision: 'b'.repeat(40),
    })
  );
  await fleetState({ init: true, directory: first.remote }, second.services);
  expect(readDocument(second.database, 'enrollment')).toBeNull();
  expect(readDocument(second.database, 'definition')).not.toBeNull();
});

test('credentials come from the environment or a prompt and are stored privately, never echoed', async () => {
  const { services } = await manager();
  const secret = 'secret/example+key';
  const asked: string[] = [];
  const result = await fleetState(
    {
      init: true,
      bucket: 'fleet-state',
      endpoint: 'https://s3.example.com',
      region: 'auto',
    },
    {
      ...services,
      ask: async (question) => {
        asked.push(question);
        return question.includes('secret') ? secret : 'AKIDEXAMPLE';
      },
    }
  );
  expect(asked).toEqual([
    'Bucket access key ID (empty to use the AWS environment or profile)',
    'Bucket secret access key',
  ]);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.data).toMatchObject({
    bucket: {
      kind: 's3',
      bucket: 'fleet-state',
      prefix: 'dev-fleet',
      credentials: 'bucket.json',
    },
  });
  const saved = JSON.parse(
    readFileSync(bucketPath({}, services.home), 'utf8')
  ) as Record<string, unknown>;
  expect(saved['secretAccessKey']).toBe(secret);
  // No terminal and no environment: the standard AWS environment is used.
  const other = await manager();
  const plain = await fleetState(
    { init: true, bucket: 'fleet-state' },
    other.services
  );
  expect(plain.data).toMatchObject({
    bucket: { location: 'bucket.json', credentials: 'aws' },
  });
  await expect(
    fleetState(
      { init: true, bucket: 'fleet-state' },
      { ...other.services, env: { DEVFLEET_BUCKET_ACCESS_KEY_ID: 'AKID' } }
    )
  ).rejects.toThrow('never taken from arguments');
});

test('restore discards local changes only when told to, and push uploads them', async () => {
  const first = await manager();
  await fleetState({ init: true, directory: first.remote }, first.services);
  await fleetState({ import: EXAMPLE }, first.services);
  const edited = join(first.services.home, 'edited.json');
  writeFileSync(
    edited,
    readFileSync(EXAMPLE, 'utf8').replaceAll('worker-two', 'worker-renamed')
  );
  first.bucket.down = true;
  const offline = await fleetState({ import: edited }, first.services);
  expect(offline.exitCode).toBe(1);
  expect(offline.data).toMatchObject({ standing: 'unreachable' });
  first.bucket.down = false;
  expect((await fleetState({}, first.services)).data).toMatchObject({
    standing: 'local-ahead',
  });
  await expect(fleetState({ restore: true }, first.services)).rejects.toThrow(
    'repeat with --yes'
  );
  const pushed = await fleetState({ push: true }, first.services);
  expect(pushed.data).toMatchObject({ standing: 'in-sync' });
  expect(pushed.exitCode).toBe(0);
  const restored = await fleetState({ restore: true }, first.services);
  expect(restored.exitCode).toBe(0);
  expect(readDocument(first.database, 'definition')).toContain(
    'worker-renamed'
  );
});

test('usage errors name the flag, and an invalid configuration is never stored', async () => {
  const { services, database } = await manager();
  const broken = join(services.home, 'broken.json');
  writeFileSync(broken, JSON.stringify({ version: 3 }));
  await expect(fleetState({ import: broken }, services)).rejects.toThrow(
    'Invalid Fleet definition'
  );
  await expect(
    fleetState({ import: join(services.home, 'missing.json') }, services)
  ).rejects.toThrow('readable JSON file');
  expect(readDocument(database, 'definition')).toBeNull();
  await expect(fleetState({ export: true }, services)).rejects.toThrow(
    'holds no fleet configuration'
  );
  await expect(fleetState({ restore: true }, services)).rejects.toThrow(
    'No bucket is configured'
  );
  await expect(
    fleetState({ init: true, push: true }, services)
  ).rejects.toThrow('Choose one of');
  await expect(fleetState({ bucket: 'fleet-state' }, services)).rejects.toThrow(
    'belong to --init'
  );
  await expect(
    fleetState({ init: true, endpoint: 'https://s3.example.com' }, services)
  ).rejects.toThrow('need --bucket');
  await expect(
    fleetState(
      { init: true, bucket: 'fleet-state', directory: '/tmp/fleet' },
      services
    )
  ).rejects.toThrow('not both');
});

test('the command is registered, documented and read-only without a flag', async () => {
  const settings = { workspace: '/no-checkout', config: '/no-roster' };
  const help = await execute(['fleet-state', '--help'], settings, '0.1.0');
  expect(help.exitCode).toBe(0);
  for (const flag of ['--init', '--bucket', '--push', '--restore', '--import'])
    expect(help.text).toContain(flag);
  // The test process has its own empty state directory and no bucket.
  const status = await execute(['fleet-state', '--json'], settings, '0.1.0');
  expect(status.data).toMatchObject({
    command: 'fleet-state',
    standing: 'local-only',
    root: process.env['DEVFLEET_STATE']!,
  });
});

/** A project of the operator's own: the example with a bucket named in it. */
function project(home: string, state: Record<string, string>): string {
  const path = join(home, 'project/fleet.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(EXAMPLE, 'utf8')), state })
  );
  return path;
}

const KEYS = {
  DEVFLEET_BUCKET_ACCESS_KEY_ID: 'AKIDPASSED',
  DEVFLEET_BUCKET_SECRET_ACCESS_KEY: 'secret/passed+key',
};

test('a project that names its bucket needs only credentials passed to each command', async () => {
  const { services, bucket } = await manager();
  const env = {
    DEVFLEET_CONFIG: project(services.home, {
      bucket: 'fleet-state',
      endpoint: 'https://s3.example.com',
    }),
    ...KEYS,
  };
  const pushed = await fleetState({ push: true }, { ...services, env });
  expect(pushed.data).toMatchObject({
    standing: 'empty',
    bucket: {
      bucket: 'fleet-state',
      location: 'fleet.json',
      credentials: 'environment',
    },
  });
  expect(checks(pushed.data)).toMatchObject({
    'state:bucket': 'pass',
    'state:definition': 'pass',
  });
  // Litestream was handed the passed keys, and nothing was saved here.
  expect(bucket.calls.at(-1)!.env).toMatchObject({
    AWS_ACCESS_KEY_ID: KEYS.DEVFLEET_BUCKET_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: KEYS.DEVFLEET_BUCKET_SECRET_ACCESS_KEY,
  });
  expect(existsSync(bucketPath({}, services.home))).toBe(false);
  expect(JSON.stringify(pushed)).not.toContain('secret/passed');
  // The bucket is the project's to name: a flag cannot point elsewhere.
  await expect(
    fleetState({ init: true, bucket: 'another-fleet' }, { ...services, env })
  ).rejects.toThrow('names another bucket');
});

test('init saves the project’s bucket and the passed credentials for runs this machine starts by itself', async () => {
  const { services } = await manager();
  const config = project(services.home, { bucket: 'fleet-state' });
  const saved = () =>
    JSON.parse(readFileSync(bucketPath({}, services.home), 'utf8')) as Record<
      string,
      unknown
    >;
  const connected = await fleetState(
    { init: true },
    { ...services, env: { DEVFLEET_CONFIG: config, ...KEYS } }
  );
  expect(connected.exitCode).toBe(0);
  expect(saved()).toMatchObject({
    bucket: 'fleet-state',
    accessKeyId: KEYS.DEVFLEET_BUCKET_ACCESS_KEY_ID,
    secretAccessKey: KEYS.DEVFLEET_BUCKET_SECRET_ACCESS_KEY,
  });
  // A later command that is passed nothing (the schedule) uses them.
  const unattended = { ...services, env: { DEVFLEET_CONFIG: config } };
  expect((await fleetState({}, unattended)).data).toMatchObject({
    bucket: { location: 'fleet.json', credentials: 'bucket.json' },
  });
  // Repeating --init without credentials keeps them; passing new ones rotates.
  await fleetState({ init: true }, unattended);
  expect(saved()['accessKeyId']).toBe(KEYS.DEVFLEET_BUCKET_ACCESS_KEY_ID);
  await fleetState(
    { init: true },
    {
      ...services,
      env: {
        DEVFLEET_CONFIG: config,
        DEVFLEET_BUCKET_ACCESS_KEY_ID: 'AKIDROTATED',
        DEVFLEET_BUCKET_SECRET_ACCESS_KEY: 'secret/rotated',
      },
    }
  );
  expect(saved()['accessKeyId']).toBe('AKIDROTATED');
});

test('the example printed to start a project from is a valid configuration without credentials', async () => {
  const { services, bucket } = await manager();
  const example = await fleetState({ example: true }, services);
  expect(example.exitCode).toBe(0);
  const { definition } = example.data as {
    definition: Record<string, unknown>;
  };
  expect(JSON.parse(example.text!)).toEqual(definition);
  expect(definition['$schema']).toBe(
    './node_modules/@crvouga/dev-fleet/schema/fleet.schema.json'
  );
  const { parseDefinition } = await import('../../src/definition');
  expect(parseDefinition(definition).state).toMatchObject({
    bucket: 'my-fleet-state',
  });
  expect(example.text).not.toContain('accessKey');
  // Read-only: no bucket, no state.
  expect(bucket.calls).toHaveLength(0);
  expect(existsSync(stateRoot({}, services.home))).toBe(false);
});
