import { record } from '../config';
import type { HubBackups } from '../definition';
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
/** Declared backups that have not reached off-machine storage for this long
 * fail: the grace covers a fresh hub and a storage outage of a few days.
 */
export const BACKUP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

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

const UNDECLARED =
  'Declare services.monitoring.backups in fleet.json (a schedule, how many to keep and S3-compatible storage off the manager) and the secrets monitoring-backup-access-key and monitoring-backup-secret-key; fleet-sync then sets them through the hub.';
const DECLARED =
  "fleet-sync sets the backups declared under services.monitoring.backups. Check that the secrets monitoring-backup-access-key and monitoring-backup-secret-key are readable on the manager and that the manager's Vault session is logged in, then rerun fleet-sync.";

/** Reads the hub's own backup settings and its list of backups through the
 * stock PocketBase API of the pinned release (superuser only: GET
 * /api/settings and GET /api/backups): whether they are scheduled, kept off
 * the manager and recent. fleet-sync sets them from the fleet configuration
 * (`hub-darwin.yml`); with them declared, anything but that is a failure, a
 * stale backup after a grace period. Storage names, keys and endpoints are
 * never reported.
 */
export async function verifyHubBackups(
  login: HubLogin | null,
  fetcher: typeof fetch = fetch,
  base: string = LOCAL_HUB,
  options: { now?: number; declared?: HubBackups | undefined } = {}
): Promise<Check> {
  const SETTINGS = options.declared ? DECLARED : UNDECLARED;
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
  return judgeBackups(
    policy,
    newestBackup(backups),
    options.now ?? Date.now(),
    options.declared
  );
}

/** Undeclared backups only warn; declared ones fail when they are not what
 * the fleet configuration says, or have not reached storage for longer than
 * the grace period.
 */
function judgeBackups(
  policy: { cron: string; keep: number; offHost: boolean },
  newest: number | null,
  now: number,
  declared: HubBackups | undefined
): Check {
  const SETTINGS = declared ? DECLARED : UNDECLARED;
  const missing: Check['status'] = declared ? 'fail' : 'warn';
  if (!policy.cron)
    return backupCheck(
      missing,
      'BESZEL_BACKUP_UNSCHEDULED',
      `The hub takes no scheduled backups, so its history, settings and machine identities are lost with the manager. ${SETTINGS}`
    );
  if (!policy.offHost)
    return backupCheck(
      missing,
      'BESZEL_BACKUP_OFFHOST_REQUIRED',
      `Scheduled backups stay on the manager's disk, which is not disaster recovery. ${SETTINGS} Use encrypted S3-compatible storage you already approved; do not create new storage or reuse unrelated credentials.`
    );
  if (
    declared &&
    (policy.cron !== declared.schedule || policy.keep !== declared.keep)
  )
    return backupCheck(
      'fail',
      'BESZEL_BACKUP_NOT_CONVERGED',
      `The hub's backup schedule is not the one the fleet configuration declares. ${SETTINGS}`
    );
  const age = newest === null ? null : now - newest;
  if (age === null || age > BACKUP_MAX_AGE_MS)
    return backupCheck(
      staleStatus(age, declared !== undefined),
      'BESZEL_BACKUP_STALE',
      `No backup newer than ${BACKUP_MAX_AGE_MS / 3_600_000} hours is listed although a schedule is set. Check the storage's credentials and that the hub can reach it, then create a backup by hand (the hub's /_/ page, Settings > Backups). ${SETTINGS}`
    );
  return backupCheck(
    'pass',
    `Scheduled backups go to off-host storage, keeping ${policy.keep}; the newest is from ${new Date(now - age).toISOString()}.`
  );
}

/** A fresh hub has no backup yet; declared backups that stopped reaching
 * storage fail once the grace period is over.
 */
function staleStatus(age: number | null, declared: boolean): Check['status'] {
  return declared && age !== null && age > BACKUP_GRACE_MS ? 'fail' : 'warn';
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
