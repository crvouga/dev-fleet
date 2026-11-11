import { FleetUsageError } from '../errors';
import { canonical, hash, object, read } from './files';

export type Change = {
  id: string;
  action: 'create' | 'update' | 'delete' | 'unchanged' | 'conflict';
};
export type T3Paths = { settings: string; state: string };

export async function planT3(paths: T3Paths, desired: Record<string, unknown>) {
  const raw = await read(paths.settings);
  const stateRaw = await read(paths.state);
  const settings = object(raw);
  const current = object(JSON.stringify(settings['providerInstances'] ?? {}));
  const owned = readOwnership(stateRaw, paths.settings);
  const next = { ...current };
  const changes: Change[] = [];
  for (const [id, instance] of Object.entries(desired)) {
    const exists = Object.hasOwn(current, id);
    const action = actionFor(exists, owned.includes(id), current[id], instance);
    changes.push({ id, action });
    if (action !== 'conflict') next[id] = instance;
  }
  for (const id of owned.filter((id) => !Object.hasOwn(desired, id))) {
    changes.push({
      id,
      action: Object.hasOwn(current, id) ? 'delete' : 'unchanged',
    });
    delete next[id];
  }
  const settingsChanged = canonical(next) !== canonical(current);
  const state = ownership(paths.settings, Object.keys(desired));
  return {
    raw,
    stateRaw,
    settings: settingsChanged
      ? { ...settings, providerInstances: next }
      : settings,
    state,
    settingsChanged,
    stateChanged: canonical(object(stateRaw)) !== canonical(state),
    changes,
    planHash: hash(
      canonical({ target: paths.settings, raw, stateRaw, desired })
    ),
  };
}

export function ownership(target: string, ids: string[]) {
  return { version: 1, target, instances: [...ids].sort() };
}

export function readOwnership(raw: string | null, target: string): string[] {
  if (raw === null) return [];
  const state = object(raw);
  const ids = state['instances'];
  if (
    state['version'] !== 1 ||
    state['target'] !== target ||
    !Array.isArray(ids) ||
    ids.some(
      (id) =>
        typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)
    ) ||
    new Set(ids).size !== ids.length
  )
    throw new FleetUsageError(
      'Invalid T3 ownership state; restore its backup before reconciliation.'
    );
  return ids as string[];
}

function actionFor(
  exists: boolean,
  owned: boolean,
  current: unknown,
  desired: unknown
): Change['action'] {
  if (exists && !owned) return 'conflict';
  if (!exists) return 'create';
  return canonical(current) === canonical(desired) ? 'unchanged' : 'update';
}
