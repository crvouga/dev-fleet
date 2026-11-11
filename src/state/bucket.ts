import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { record } from '../config';
import { FleetUsageError } from '../errors';

/** Where the fleet's state is kept for good. An S3-compatible bucket (AWS S3,
 * Cloudflare R2, Backblaze B2, MinIO) is the usual one; a directory on an
 * attached disk or a mounted share works the same way.
 */
export type Bucket =
  | {
      kind: 's3';
      bucket: string;
      /** Omitted for AWS S3 itself. */
      endpoint?: string;
      region?: string;
      /** Key prefix, so one bucket can hold more than this fleet's state. */
      prefix: string;
      /** Omitted to use the standard AWS environment or profile. */
      accessKeyId?: string;
      secretAccessKey?: string;
    }
  | { kind: 'directory'; path: string };

export const DEFAULT_PREFIX = 'dev-fleet';

const text = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value);

const ENDPOINT =
  /^(https:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)$/;
const KEY = /^[\x21-\x7e]{1,512}$/;

function invalid(reason: string): never {
  throw new FleetUsageError(`Invalid bucket settings: ${reason}`);
}

function directory(value: Record<string, unknown>): Bucket {
  if (Object.keys(value).some((key) => !['version', 'directory'].includes(key)))
    invalid('a directory takes no other setting.');
  const path = value['directory'];
  if (!text(path, /^\/[^\x00-\x1f\x7f]{1,4000}$/))
    invalid('directory must be an absolute path.');
  return { kind: 'directory', path };
}

function prefix(value: unknown): string {
  if (value === undefined) return DEFAULT_PREFIX;
  if (
    !text(value, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/) ||
    value.includes('..') ||
    value.endsWith('/')
  )
    invalid('prefix must be a plain key prefix such as dev-fleet.');
  return value;
}

function credentials(
  value: Record<string, unknown>
): { accessKeyId: string; secretAccessKey: string } | Record<string, never> {
  const { accessKeyId, secretAccessKey } = value;
  if (accessKeyId === undefined && secretAccessKey === undefined) return {};
  if (!text(accessKeyId, KEY) || !text(secretAccessKey, KEY))
    invalid('accessKeyId and secretAccessKey must be given together.');
  return { accessKeyId, secretAccessKey };
}

const S3_SETTINGS = [
  'version',
  'bucket',
  'endpoint',
  'region',
  'prefix',
  'accessKeyId',
  'secretAccessKey',
];

function s3(value: Record<string, unknown>): Bucket {
  if (Object.keys(value).some((key) => !S3_SETTINGS.includes(key)))
    invalid('unknown setting.');
  const { bucket, endpoint, region } = value;
  if (!text(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/))
    invalid('bucket must be a bucket name.');
  if (endpoint !== undefined && !text(endpoint, ENDPOINT))
    invalid('endpoint must be an https:// origin without a path.');
  if (region !== undefined && !text(region, /^[a-z0-9-]{1,32}$/))
    invalid('region must be a region name such as auto or us-east-1.');
  return {
    kind: 's3',
    bucket,
    ...(endpoint ? { endpoint } : {}),
    ...(region ? { region } : {}),
    prefix: prefix(value['prefix']),
    ...credentials(value),
  };
}

/** The contents of bucket.json, or the same fields from `fleet-state --init`. */
export function parseBucket(value: unknown): Bucket {
  if (!record(value)) return invalid('expected a JSON object.');
  if (value['version'] !== undefined && value['version'] !== 1)
    invalid('unsupported version.');
  return value['directory'] !== undefined ? directory(value) : s3(value);
}

/** Null when this machine has no bucket. The file holds credentials, so one
 * that other users can read is refused rather than used.
 */
export function readBucket(path: string): Bucket | null {
  if (!existsSync(path)) return null;
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0)
    throw new FleetUsageError(
      `${path} holds bucket credentials and must be private. Run chmod 600 on it.`
    );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return invalid('the file is not JSON.');
  }
  return parseBucket(value);
}

export function writeBucket(path: string, bucket: Bucket): void {
  const { kind, ...settings } = bucket;
  const body =
    kind === 'directory'
      ? { version: 1, directory: bucket.path }
      : { version: 1, ...settings };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(body, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** What a report may say about the bucket: never a credential. */
export function describeBucket(bucket: Bucket | null): Record<string, unknown> {
  if (!bucket) return { configured: false };
  if (bucket.kind === 'directory')
    return { configured: true, kind: 'directory', directory: bucket.path };
  return {
    configured: true,
    kind: 's3',
    bucket: bucket.bucket,
    ...(bucket.endpoint ? { endpoint: bucket.endpoint } : {}),
    ...(bucket.region ? { region: bucket.region } : {}),
    prefix: bucket.prefix,
    credentials: bucket.accessKeyId ? 'bucket.json' : 'environment',
  };
}

/** The same target replicates the same database; a different one starts over. */
export function bucketIdentity(bucket: Bucket): string {
  return bucket.kind === 'directory'
    ? `directory:${bucket.path}`
    : `s3:${bucket.endpoint ?? 'aws'}/${bucket.bucket}/${bucket.prefix}`;
}
