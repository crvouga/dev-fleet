import { homedir } from 'node:os';
import { FleetUsageError } from '../errors';
import { declaredState } from '../fleet-config';
import {
  ACCESS_KEY_ID_ENV,
  SECRET_ACCESS_KEY_ENV,
  bucketIdentity,
  parseLocation,
  readBucket,
  withCredentials,
  type Bucket,
} from './bucket';
import { bucketPath } from './paths';

/** How a devfleet command reaches the bucket, and where each part came from.
 * Never a credential itself.
 */
export interface Connection {
  bucket: Bucket | null;
  /** `configuration`: the `state` block of the fleet configuration.
   * `saved`: this machine's bucket.json.
   */
  location: 'configuration' | 'saved' | null;
  /** `environment`: the two `DEVFLEET_BUCKET_*` variables. `saved`: this
   * machine's bucket.json. `ambient`: none given, so the standard AWS
   * environment or profile.
   */
  credentials: 'environment' | 'saved' | 'ambient' | null;
}

/** The credentials passed to this command, or null. */
export function environmentCredentials(
  env: NodeJS.ProcessEnv
): { accessKeyId: string; secretAccessKey: string } | null {
  const accessKeyId = env[ACCESS_KEY_ID_ENV];
  const secretAccessKey = env[SECRET_ACCESS_KEY_ENV];
  if (!accessKeyId && !secretAccessKey) return null;
  if (!accessKeyId || !secretAccessKey)
    throw new FleetUsageError(
      `Set both ${ACCESS_KEY_ID_ENV} and ${SECRET_ACCESS_KEY_ENV}, or neither. Credentials are never taken from arguments.`
    );
  return { accessKeyId, secretAccessKey };
}

/** The configuration says where the bucket is; credentials are passed to the
 * command. A machine that runs unattended (the schedule, a hand-off from a
 * worker) gets no environment, so `fleet-state --init` may save both there:
 * a saved location is used when the configuration names none, and saved
 * credentials only for the bucket they were saved for.
 */
export function resolveConnection(
  declared: Bucket | null,
  saved: Bucket | null,
  env: NodeJS.ProcessEnv
): Connection {
  const target = declared ?? saved;
  if (!target) return { bucket: null, location: null, credentials: null };
  const location = declared ? 'configuration' : 'saved';
  if (target.kind === 'directory')
    return { bucket: target, location, credentials: null };
  const given = environmentCredentials(env);
  if (given)
    return {
      bucket: withCredentials(target, given),
      location,
      credentials: 'environment',
    };
  if (
    saved?.kind === 's3' &&
    saved.accessKeyId &&
    bucketIdentity(saved) === bucketIdentity(target)
  )
    return {
      bucket: withCredentials(target, saved),
      location,
      credentials: 'saved',
    };
  return {
    bucket: withCredentials(target, {}),
    location,
    credentials: 'ambient',
  };
}

export function connection(env = process.env, home = homedir()): Connection {
  const declared = declaredState(env, home);
  return resolveConnection(
    declared ? parseLocation(declared) : null,
    readBucket(bucketPath(env, home)),
    env
  );
}
