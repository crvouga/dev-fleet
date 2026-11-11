import { afterEach, expect, test } from 'bun:test';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketIdentity,
  describeBucket,
  parseBucket,
  readBucket,
  writeBucket,
} from '../../src/state/bucket';
import {
  litestreamConfig,
  litestreamEnvironment,
} from '../../src/state/litestream';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fleet-bucket-'));
  roots.push(root);
  return root;
}

const S3 = {
  bucket: 'fleet-state',
  endpoint: 'https://s3.example.com',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret/example+key',
};

test('an S3 bucket and a directory are both accepted, with a default prefix', () => {
  expect(parseBucket(S3)).toEqual({ kind: 's3', prefix: 'dev-fleet', ...S3 });
  expect(parseBucket({ bucket: 'fleet-state' })).toEqual({
    kind: 's3',
    bucket: 'fleet-state',
    prefix: 'dev-fleet',
  });
  expect(parseBucket({ directory: '/Volumes/backup/fleet' })).toEqual({
    kind: 'directory',
    path: '/Volumes/backup/fleet',
  });
});

test('settings that would leak or misroute the state are refused', () => {
  for (const settings of [
    null,
    { version: 2, bucket: 'fleet-state' },
    { bucket: 'Fleet_State' },
    { bucket: 'fleet-state', endpoint: 'http://s3.example.com' },
    { bucket: 'fleet-state', endpoint: 'https://s3.example.com/path' },
    { bucket: 'fleet-state', prefix: '../other' },
    { bucket: 'fleet-state', prefix: 'trailing/' },
    { bucket: 'fleet-state', accessKeyId: 'only-half' },
    { bucket: 'fleet-state', token: 'unknown' },
    { directory: 'relative/path' },
    { directory: '/a', bucket: 'fleet-state' },
  ])
    expect(() => parseBucket(settings)).toThrow('Invalid bucket settings');
  // A local S3 service for trying it out is the one plain-HTTP exception.
  expect(
    parseBucket({ bucket: 'fleet-state', endpoint: 'http://127.0.0.1:9000' })
  ).toMatchObject({ endpoint: 'http://127.0.0.1:9000' });
});

test('bucket.json is written privately and one others can read is not used', async () => {
  const path = join(await directory(), 'config', 'bucket.json');
  expect(readBucket(path)).toBeNull();
  writeBucket(path, parseBucket(S3));
  expect(statSync(path).mode & 0o077).toBe(0);
  expect(readBucket(path)).toEqual(parseBucket(S3));
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1 });
  chmodSync(path, 0o644);
  expect(() => readBucket(path)).toThrow('must be private');
  chmodSync(path, 0o600);
  writeFileSync(path, 'not json');
  expect(() => readBucket(path)).toThrow('Invalid bucket settings');
});

test('nothing printed or passed as an argument carries a credential', () => {
  const bucket = parseBucket(S3);
  const described = JSON.stringify(describeBucket(bucket));
  const config = litestreamConfig('/state/fleet.db', bucket);
  for (const text of [described, config, bucketIdentity(bucket)]) {
    expect(text).not.toContain(S3.accessKeyId);
    expect(text).not.toContain(S3.secretAccessKey);
  }
  expect(litestreamEnvironment(bucket)).toEqual({
    AWS_ACCESS_KEY_ID: S3.accessKeyId,
    AWS_SECRET_ACCESS_KEY: S3.secretAccessKey,
    AWS_SESSION_TOKEN: '',
  });
  // Without keys in bucket.json the standard AWS environment is left alone.
  expect(litestreamEnvironment(parseBucket({ bucket: 'fleet-state' }))).toEqual(
    {}
  );
  expect(describeBucket(null)).toEqual({ configured: false });
});

test('the Litestream configuration names the replica and nothing else', () => {
  const config = litestreamConfig('/state/fleet.db', parseBucket(S3));
  expect(config).toContain('type: s3');
  expect(config).toContain('bucket: fleet-state');
  expect(config).toContain('path: dev-fleet/fleet.db');
  expect(config).toContain('endpoint: https://s3.example.com');
  expect(config).toContain('force-path-style: true');
  const local = litestreamConfig(
    '/state/fleet.db',
    parseBucket({ directory: '/Volumes/backup/fleet' })
  );
  expect(local).toContain('type: file');
  expect(local).toContain('path: /Volumes/backup/fleet/fleet.db');
});
