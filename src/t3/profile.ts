import { dirname, join } from 'node:path';
import type { Check } from '../types';
import { canonical, object, read, write } from './files';

/** What happens to one declared setting. `release` stops managing a key the
 * fleet no longer declares and leaves its value to the machine.
 */
export type ProfileAction =
  'create' | 'update' | 'delete' | 'release' | 'unchanged' | 'conflict';
export type ProfileChange = { key: string; action: ProfileAction };

/** The values the fleet last wrote, kept beside T3's settings: the base of
 * the three-way merge between what is declared, what T3 holds and what was
 * applied before.
 */
export const profileRecord = (settings: string): string =>
  join(dirname(settings), 'personal-profile.json');

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** Managed keys converge, keys nobody declared are left alone, and a key
 * changed on the machine since the fleet last wrote it (or that existed
 * before the fleet declared it) is a conflict, never overwritten.
 */
export function planProfile(
  settings: Record<string, unknown>,
  applied: Record<string, unknown>,
  declared: Record<string, unknown>
) {
  const next = { ...settings };
  const record = { ...applied };
  const changes: ProfileChange[] = [];
  const keys = [
    ...new Set([...Object.keys(declared), ...Object.keys(applied)]),
  ].sort();
  for (const key of keys) {
    const present = Object.hasOwn(settings, key);
    const managed = Object.hasOwn(applied, key);
    const action = actionFor(key, declared, {
      present,
      managed,
      current: settings[key],
      base: applied[key],
    });
    changes.push({ key, action });
    if (action === 'create' || action === 'update') {
      next[key] = declared[key];
      record[key] = declared[key];
    } else if (action === 'unchanged') record[key] = declared[key];
    else if (action === 'delete') {
      delete next[key];
      delete record[key];
    } else if (action === 'release') delete record[key];
  }
  return {
    settings: next,
    record,
    changes,
    settingsChanged: !same(next, settings),
    recordChanged: !same(record, applied),
  };
}

function actionFor(
  key: string,
  declared: Record<string, unknown>,
  {
    present,
    managed,
    current,
    base,
  }: { present: boolean; managed: boolean; current: unknown; base: unknown }
): ProfileAction {
  if (!Object.hasOwn(declared, key)) {
    if (present && same(current, base)) return 'delete';
    return 'release';
  }
  const wanted = declared[key];
  if (present && same(current, wanted)) return 'unchanged';
  if (!present) return managed ? 'conflict' : 'create';
  return managed && same(current, base) ? 'update' : 'conflict';
}

export interface ProfileOptions {
  apply: boolean;
  /** Tries before a settings file T3 keeps rewriting is reported busy. */
  attempts?: number;
  pause?: () => Promise<void>;
  /** Runs between the read and the write: where T3 may write too. */
  beforeWrite?: () => Promise<void>;
}

/** Plans, and with `apply` writes, the declared profile. T3 writes the same
 * file and offers no compare-and-swap, so a write happens only when the file
 * is still what was read; otherwise the merge is planned again, a bounded
 * number of times.
 */
export async function reconcileProfile(
  settingsPath: string,
  declared: Record<string, unknown>,
  options: ProfileOptions
) {
  const recordPath = profileRecord(settingsPath);
  const attempts = options.attempts ?? 3;
  const pause =
    options.pause ?? (() => new Promise((done) => setTimeout(done, 500)));
  for (let attempt = 1; ; attempt++) {
    const raw = await read(settingsPath);
    const recordRaw = await read(recordPath);
    const plan = planProfile(
      object(raw),
      readRecord(recordRaw, settingsPath),
      declared
    );
    if (!options.apply || (!plan.settingsChanged && !plan.recordChanged))
      return { ...plan, applied: false };
    await options.beforeWrite?.();
    if (!plan.settingsChanged || (await read(settingsPath)) === raw) {
      if (plan.settingsChanged)
        await write(
          settingsPath,
          JSON.stringify(plan.settings, null, 2) + '\n'
        );
      await write(
        recordPath,
        canonical({ version: 1, target: settingsPath, settings: plan.record }) +
          '\n'
      );
      return { ...plan, applied: true };
    }
    if (attempt >= attempts) throw new Error('T3_SETTINGS_BUSY');
    await pause();
  }
}

function readRecord(
  raw: string | null,
  target: string
): Record<string, unknown> {
  if (raw === null) return {};
  const record = object(raw);
  if (record['version'] !== 1 || record['target'] !== target)
    throw new Error('T3_PROFILE_RECORD_INVALID');
  return object(JSON.stringify(record['settings'] ?? {}));
}

/** `t3:profile`: the declared settings on this machine. A report names the
 * keys and what happens to them, never a value: a tool server's settings may
 * carry a credential.
 */
export async function profileCheck(
  settingsPath: string,
  declared: Record<string, unknown>,
  options: ProfileOptions
): Promise<Check> {
  const remedy = (action: string) => ({ remedy: { action } });
  try {
    const result = await reconcileProfile(settingsPath, declared, options);
    const conflicts = result.changes.filter(
      (change) => change.action === 'conflict'
    );
    if (conflicts.length)
      return {
        id: 't3:profile',
        status: 'warn',
        summary: 'T3_PROFILE_CONFLICT',
        ...remedy(
          `These T3 settings were changed on this machine since dev-fleet last wrote them, or existed before they were declared, and were left as they are: ${conflicts.map((change) => change.key).join(', ')}. Put the value every machine should hold under t3.profile in fleet.json, or remove the setting on this machine, then run fleet-sync.`
        ),
      };
    const pending = result.changes.filter(
      (change) => !['unchanged', 'conflict'].includes(change.action)
    );
    if (!options.apply && pending.length)
      return {
        id: 't3:profile',
        status: 'warn',
        summary: 'T3_PROFILE_PENDING',
        ...remedy(
          `fleet-sync would change these T3 settings: ${pending.map((change) => `${change.key} (${change.action})`).join(', ')}.`
        ),
      };
    return {
      id: 't3:profile',
      status: 'pass',
      summary: Object.keys(declared).length
        ? 'T3 on this machine holds every setting of the declared profile; settings nobody declared are its own.'
        : 'No T3 profile is declared; every setting stays local.',
    };
  } catch (error) {
    const busy = error instanceof Error && error.message === 'T3_SETTINGS_BUSY';
    return {
      id: 't3:profile',
      status: 'fail',
      summary: busy ? 'T3_SETTINGS_BUSY' : 'T3_PROFILE_UNVERIFIED',
      ...remedy(
        busy
          ? 'T3 kept rewriting its settings while dev-fleet merged the profile. Run fleet-sync again; nothing was overwritten.'
          : 'Repair T3’s settings.json (or restore personal-profile.json from a backup) on this machine, then run fleet-sync.'
      ),
    };
  }
}
