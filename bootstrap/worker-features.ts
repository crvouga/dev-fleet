import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How a worker runs T3: `desktop`, the pinned desktop app in an auto-login
 * graphical session, or `headless`, the pinned native server as a lingering
 * user service with no display manager (docs/worker-contract.md).
 */
export const SESSIONS = ['desktop', 'headless'] as const;
export type Session = (typeof SESSIONS)[number];

/** What a worker is built with beyond the base that every worker has. */
export interface WorkerFeatures {
  /** Docker: its packages, service, group membership, CLI and clean-up. */
  containers: boolean;
  session: Session;
}

/** A fleet that names no feature gets exactly what every worker had before
 * features existed. */
export const DEFAULT_FEATURES: WorkerFeatures = {
  containers: true,
  session: 'desktop',
};

/** Named sets of features. `editing` is a worker for remote code editing by
 * agents: no containers, no desktop, and only the base tools (it adds no
 * tool profile).
 */
export const PRESETS = {
  editing: { containers: false, session: 'headless' },
} as const satisfies Record<string, WorkerFeatures>;
export type Preset = keyof typeof PRESETS;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first field of a `features` block that breaks its rule, with what
 * it expects; null when the block is valid. */
export function featuresFault(
  value: unknown
): { field: string; expected: string } | null {
  if (!record(value)) return { field: '', expected: 'an object' };
  const expected: Record<string, string> = {
    preset: `one of ${Object.keys(PRESETS).join(', ')}`,
    containers: 'true or false',
    session: `one of ${SESSIONS.join(', ')}`,
  };
  const unknown = Object.keys(value).find((key) => !(key in expected));
  if (unknown !== undefined)
    return { field: unknown, expected: 'preset, containers or session' };
  const valid: Record<string, (item: unknown) => boolean> = {
    preset: (item) => typeof item === 'string' && Object.hasOwn(PRESETS, item),
    containers: (item) => typeof item === 'boolean',
    session: (item) => SESSIONS.includes(item as Session),
  };
  const field = Object.keys(value).find((key) => !valid[key]!(value[key]));
  return field === undefined ? null : { field, expected: expected[field]! };
}

/** One block over the features before it: its preset, then its own fields. */
function over(base: WorkerFeatures, block: unknown): WorkerFeatures {
  if (!record(block)) return base;
  const preset =
    typeof block['preset'] === 'string' &&
    Object.hasOwn(PRESETS, block['preset'])
      ? PRESETS[block['preset'] as Preset]
      : {};
  return {
    ...base,
    ...preset,
    ...(typeof block['containers'] === 'boolean'
      ? { containers: block['containers'] }
      : {}),
    ...(SESSIONS.includes(block['session'] as Session)
      ? { session: block['session'] as Session }
      : {}),
  };
}

/** The features of one worker: the defaults, then the fleet-wide
 * `worker.features`, then the worker's own `features`, each with its preset
 * first. Read from the plain document, so the bootstrap needs no fleet code.
 */
export function workerFeatures(
  definition: unknown,
  node?: string
): WorkerFeatures {
  if (!record(definition)) return DEFAULT_FEATURES;
  const policy = record(definition['worker']) ? definition['worker'] : {};
  const workers: unknown[] = Array.isArray(definition['workers'])
    ? definition['workers']
    : [];
  const own = workers
    .filter(record)
    .find((entry) => node !== undefined && entry['id'] === node);
  return over(over(DEFAULT_FEATURES, policy['features']), own?.['features']);
}

/** The features of this worker in the fleet configuration fleet-sync
 * installed; the defaults when there is none yet.
 */
export function installedFeatures(
  node: string | undefined,
  home: string = homedir()
): WorkerFeatures {
  const path = join(home, '.config/dev-fleet/fleet.json');
  if (!existsSync(path)) return DEFAULT_FEATURES;
  try {
    return workerFeatures(JSON.parse(readFileSync(path, 'utf8')), node);
  } catch {
    return DEFAULT_FEATURES;
  }
}
