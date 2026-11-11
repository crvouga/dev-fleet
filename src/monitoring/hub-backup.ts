import { record } from '../config';
import type { Check } from '../types';
import {
  LOCAL_HUB,
  api,
  superuserToken,
  type HubLogin,
  type Session,
} from './hub-viewer';

/** A scheduled backup older than this means the schedule is not running. */
export const BACKUP_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function backupCheck(
  status: Check['status'],
  summary: string,
  action?: string
): Check {
  return {
    id: 'beszel:backup',
    status,
    summary,
    ...(action ? { remedy: { action } } : {}),
  };
}

const SETTINGS =
  'Open the hub as its superuser (/_/ on the manager), Settings > Backups.';

/** Reads, never changes, the hub's own backup settings and its list of
 * backups through the stock PocketBase API of the pinned release (superuser
 * only: GET /api/settings and GET /api/backups). Backups are configured in
 * the hub's UI; this says whether they are scheduled, kept off the manager
 * and recent. Storage names, keys and endpoints are never reported.
 */
export async function verifyHubBackups(
  login: HubLogin | null,
  fetcher: typeof fetch = fetch,
  base: string = LOCAL_HUB,
  now: number = Date.now()
): Promise<Check> {
  if (!login)
    return backupCheck(
      'skip',
      'BESZEL_BACKUP_UNVERIFIED',
      "The fleet admin login is unavailable, so the hub's backups were not read. Log the manager's Vault session in and rerun fleet-sync."
    );
  let settings: unknown;
  let backups: unknown;
  try {
    const anonymous: Session = { fetcher, base, token: '' };
    const session = {
      ...anonymous,
      token: await superuserToken(anonymous, login),
    };
    settings = await api(session, 'GET', '/api/settings');
    backups = await api(session, 'GET', '/api/backups');
  } catch {
    return backupCheck(
      'warn',
      'BESZEL_BACKUP_UNVERIFIED',
      `The hub's backup settings could not be read with the fleet admin login. ${SETTINGS} Details are withheld.`
    );
  }
  const policy = backupPolicy(settings);
  if (!policy || !Array.isArray(backups))
    return backupCheck(
      'warn',
      'BESZEL_BACKUP_UNVERIFIED',
      `The hub answered in a form this release does not expect. ${SETTINGS}`
    );
  if (!policy.cron)
    return backupCheck(
      'warn',
      'BESZEL_BACKUP_UNSCHEDULED',
      `The hub takes no scheduled backups, so its history, settings and machine identities are lost with the manager. ${SETTINGS} Set a schedule and how many to keep.`
    );
  if (!policy.offHost)
    return backupCheck(
      'warn',
      'BESZEL_BACKUP_OFFHOST_REQUIRED',
      `Scheduled backups stay on the manager's disk, which is not disaster recovery. ${SETTINGS} Store them in existing encrypted S3-compatible storage you already approved; do not create new storage or reuse unrelated credentials.`
    );
  const newest = newestBackup(backups);
  if (newest === null || now - newest > BACKUP_MAX_AGE_MS)
    return backupCheck(
      'warn',
      'BESZEL_BACKUP_STALE',
      `No backup newer than ${BACKUP_MAX_AGE_MS / 3_600_000} hours is listed although a schedule is set. ${SETTINGS} Check the schedule and the storage's credentials, then create a backup by hand.`
    );
  return backupCheck(
    'pass',
    `Scheduled backups go to off-host storage, keeping ${policy.keep}; the newest is from ${new Date(newest).toISOString()}.`
  );
}

function backupPolicy(
  settings: unknown
): { cron: string; keep: number; offHost: boolean } | null {
  if (!record(settings) || !record(settings['backups'])) return null;
  const backups = settings['backups'];
  const s3 = record(backups['s3']) ? backups['s3'] : {};
  return {
    cron: typeof backups['cron'] === 'string' ? backups['cron'].trim() : '',
    keep:
      typeof backups['cronMaxKeep'] === 'number' ? backups['cronMaxKeep'] : 0,
    offHost: s3['enabled'] === true,
  };
}

/** PocketBase lists `modified` as "2006-01-02 15:04:05.000Z". */
function newestBackup(backups: unknown[]): number | null {
  const times = backups
    .map((entry) =>
      record(entry) && typeof entry['modified'] === 'string'
        ? Date.parse(entry['modified'].replace(' ', 'T'))
        : NaN
    )
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}
