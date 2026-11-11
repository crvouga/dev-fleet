import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import example from '../../examples/fleet.json';
import { installedDefinition, parseDefinition } from '../../src/definition';
import {
  parseBucket,
  parseLocation,
  writeBucket,
} from '../../src/state/bucket';
import { connection, resolveConnection } from '../../src/state/connection';
import { bucketPath } from '../../src/state/paths';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const PLACE = {
  bucket: 'fleet-state',
  endpoint: 'https://s3.example.com',
  region: 'auto',
};
const declared = parseLocation(PLACE);
const KEYS = {
  DEVFLEET_BUCKET_ACCESS_KEY_ID: 'AKIDPASSED',
  DEVFLEET_BUCKET_SECRET_ACCESS_KEY: 'secret/passed',
};
const saved = parseBucket({
  ...PLACE,
  accessKeyId: 'AKIDSAVED',
  secretAccessKey: 'secret/saved',
});

test('the configuration names the bucket and the command is passed its credentials', () => {
  // Nothing is saved on this machine: a project and two variables are enough.
  expect(resolveConnection(declared, null, KEYS)).toEqual({
    bucket: {
      kind: 's3',
      ...PLACE,
      prefix: 'dev-fleet',
      accessKeyId: 'AKIDPASSED',
      secretAccessKey: 'secret/passed',
    },
    location: 'configuration',
    credentials: 'environment',
  });
  // Passed credentials win over saved ones: that is how they are rotated.
  expect(resolveConnection(declared, saved, KEYS).credentials).toBe(
    'environment'
  );
  // Without any, the standard AWS environment or profile is left to answer.
  const ambient = resolveConnection(declared, null, {});
  expect(ambient.credentials).toBe('ambient');
  expect(ambient.bucket).not.toHaveProperty('accessKeyId');
  expect(() =>
    resolveConnection(declared, null, {
      DEVFLEET_BUCKET_ACCESS_KEY_ID: 'AKIDPASSED',
    })
  ).toThrow('Set both');
});

test('a machine that runs unattended uses what fleet-state --init saved on it', () => {
  expect(resolveConnection(declared, saved, {})).toMatchObject({
    bucket: { accessKeyId: 'AKIDSAVED' },
    location: 'configuration',
    credentials: 'saved',
  });
  // Without a configuration that names a bucket, the saved one is the bucket.
  expect(resolveConnection(null, saved, {})).toMatchObject({
    bucket: { bucket: 'fleet-state', accessKeyId: 'AKIDSAVED' },
    location: 'saved',
    credentials: 'saved',
  });
  // Keys saved for one bucket are never sent to another.
  const moved = parseLocation({ ...PLACE, bucket: 'another-fleet' });
  const elsewhere = resolveConnection(moved, saved, {});
  expect(elsewhere.credentials).toBe('ambient');
  expect(JSON.stringify(elsewhere)).not.toContain('AKIDSAVED');
  expect(resolveConnection(null, null, KEYS)).toEqual({
    bucket: null,
    location: null,
    credentials: null,
  });
  // A directory takes no credentials.
  const directory = parseLocation({ directory: '/Volumes/backup/fleet' });
  expect(resolveConnection(directory, saved, KEYS)).toEqual({
    bucket: { kind: 'directory', path: '/Volumes/backup/fleet' },
    location: 'configuration',
    credentials: null,
  });
});

test('the bucket is read from the fleet.json the command runs with', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-connection-'));
  roots.push(home);
  const project = join(home, 'fleet.json');
  writeFileSync(project, JSON.stringify({ ...example, state: PLACE }));
  const env = { DEVFLEET_CONFIG: project, ...KEYS };
  expect(connection(env, home)).toMatchObject({
    bucket: { bucket: 'fleet-state', accessKeyId: 'AKIDPASSED' },
    location: 'configuration',
    credentials: 'environment',
  });
  // A configuration that names none leaves the machine's saved bucket.
  const { state: _bucket, ...plain } = example;
  writeFileSync(project, JSON.stringify(plain));
  expect(connection(env, home).bucket).toBeNull();
  writeBucket(bucketPath(env, home), saved);
  expect(connection({ DEVFLEET_CONFIG: project }, home)).toMatchObject({
    location: 'saved',
    credentials: 'saved',
  });
  // No configuration at all is not an error here: the first command on a
  // new machine may be the one that restores it.
  expect(
    connection({ DEVFLEET_CONFIG: join(home, 'absent.json') }, home).location
  ).toBe('saved');
  // A broken one is: it must not silently run without its bucket.
  writeFileSync(project, '{');
  expect(() => connection(env, home)).toThrow('not readable JSON');
});

test('the example names a bucket and a configuration can never hold its credentials', () => {
  expect(parseDefinition(example).state).toEqual({
    bucket: 'my-fleet-state',
    endpoint: 'https://s3.example.com',
    region: 'auto',
    prefix: 'dev-fleet',
  });
  expect(
    parseDefinition({ ...example, state: { directory: '/mnt/fleet' } }).state
  ).toEqual({ directory: '/mnt/fleet' });
  for (const state of [
    { ...PLACE, accessKeyId: 'AKID', secretAccessKey: 'secret' },
    { ...PLACE, secretAccessKey: 'secret' },
    { ...PLACE, version: 1 },
    { endpoint: 'https://s3.example.com' },
    { bucket: 'fleet-state', directory: '/mnt/fleet' },
    'fleet-state',
  ])
    expect(() => parseDefinition({ ...example, state })).toThrow(
      'Invalid bucket settings'
    );
  expect(() =>
    parseDefinition({ ...example, state: { ...PLACE, accessKeyId: 'AKID' } })
  ).toThrow('DEVFLEET_BUCKET_ACCESS_KEY_ID');
  // The schema editors validate against accepts the same block.
  const schema = JSON.parse(
    readFileSync(
      join(import.meta.dir, '../../schema/fleet.schema.json'),
      'utf8'
    )
  ) as { properties: Record<string, { oneOf?: { properties: object }[] }> };
  const shapes = schema.properties['state']!.oneOf!.map((shape) =>
    Object.keys(shape.properties)
  );
  expect(shapes).toEqual([
    ['bucket', 'endpoint', 'region', 'prefix'],
    ['directory'],
  ]);
});

test('machines are sent the configuration without the bucket', () => {
  const definition = parseDefinition(example);
  const installed = JSON.parse(installedDefinition(definition)) as Record<
    string,
    unknown
  >;
  // A launcher from a revision that predates the block still accepts it, and
  // no worker learns where the state is kept.
  expect(installed).not.toHaveProperty('state');
  const { state: _bucket, ...rest } = definition;
  expect(installed).toEqual(rest);
  expect(parseDefinition(installed).workers).toEqual(definition.workers);
});
