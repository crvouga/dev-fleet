import { record } from './config';
import { FINGERPRINT_FILES } from './input-hashes';
import type { Check, Snapshot } from './types';

const STATUSES = ['pass', 'warn', 'fail', 'skip'];

export function validCheck(value: unknown): value is Check {
  if (
    !record(value) ||
    typeof value['id'] !== 'string' ||
    !/^[a-z0-9:._-]{1,100}$/.test(value['id']) ||
    !STATUSES.includes(String(value['status'])) ||
    typeof value['summary'] !== 'string' ||
    value['summary'].length > 2000
  )
    return false;
  if (!validDuration(value['phaseDurationMs'])) return false;
  if (!validRequired(value['required'])) return false;
  const remedy = value['remedy'];
  return remedy === undefined || validRemedy(remedy);
}

function validRemedy(value: unknown): boolean {
  return (
    record(value) &&
    typeof value['action'] === 'string' &&
    value['action'].length < 2000 &&
    (value['command'] === undefined || typeof value['command'] === 'string')
  );
}

export function validSnapshot(value: unknown): value is Snapshot {
  if (
    !record(value) ||
    value['version'] !== 1 ||
    typeof value['platform'] !== 'string' ||
    !Array.isArray(value['checks']) ||
    value['checks'].length > 200 ||
    !value['checks'].every(validCheck)
  )
    return false;
  return validFingerprint(value['fingerprint']);
}

function validFingerprint(value: unknown): boolean {
  if (!record(value) || !record(value['files'])) return false;
  if (
    !Object.keys(value['files']).every((key) => FINGERPRINT_FILES.includes(key))
  )
    return false;
  const head = value['head'];
  return (
    (head === null ||
      (typeof head === 'string' && /^[a-f0-9]{40,64}$/.test(head))) &&
    Object.values(value['files']).every(validHash)
  );
}

function validHash(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
  );
}

export function decodeSnapshot(output: string): Snapshot | null {
  try {
    const data: unknown = JSON.parse(output);
    return validSnapshot(data) ? cleanSnapshot(data) : null;
  } catch {
    return null;
  }
}

export function cleanCheck(check: Check): Check {
  return {
    id: check.id,
    status: check.status,
    summary: check.summary,
    ...(check.required !== undefined ? { required: check.required } : {}),
    ...(check.phaseDurationMs !== undefined
      ? { phaseDurationMs: check.phaseDurationMs }
      : {}),
    ...(check.remedy
      ? {
          remedy: {
            action: check.remedy.action,
            ...(check.remedy.command ? { command: check.remedy.command } : {}),
          },
        }
      : {}),
  };
}

function cleanSnapshot(snapshot: Snapshot): Snapshot {
  return {
    version: 1,
    platform: snapshot.platform,
    fingerprint: {
      head: snapshot.fingerprint.head,
      files: snapshot.fingerprint.files,
    },
    checks: snapshot.checks.map(cleanCheck),
  };
}

function validDuration(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 86_400_000)
  );
}

function validRequired(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}
