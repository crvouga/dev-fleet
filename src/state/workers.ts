import { record } from '../config';
import { HOST_KEY } from '../definition';
import { databasePath, stateRoot } from './paths';
import { readDocument, writeDocument } from './store';
import { mutateState, type StateContext, type Standing } from './sync';

/** What the manager knows of one worker that fleet.json does not say. */
export interface WorkerState {
  /** The pinned SSH host key, "TYPE BASE64", and when it was pinned. */
  hostKey?: string;
  hostKeyPinnedAt?: string;
  /** When the worker was parked: stopped or destroyed on purpose. Absent,
   * the worker is active.
   */
  parkedAt?: string;
  /** `records`: the worker was enrolled from a worker record, so it is
   * retired by itself once its record disappears.
   */
  origin?: 'records';
  /** When fleet-node-replace put a new machine in the worker's place: the
   * manager pairs its T3 with the new machine's T3 environment as soon as
   * it runs, then forgets this. A worker enrolled for the first time is
   * paired by a person.
   */
  t3PairingRequestedAt?: string;
}

/** The `workers` document of the fleet state. */
export interface WorkerStates {
  version: 1;
  workers: Record<string, WorkerState>;
}

const ID = /^[a-z][a-z0-9-]{0,62}$/;
const isTime = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const RULES: Record<keyof WorkerState, (value: unknown) => boolean> = {
  hostKey: (value) => typeof value === 'string' && HOST_KEY.test(value),
  hostKeyPinnedAt: isTime,
  parkedAt: isTime,
  origin: (value) => value === 'records',
  t3PairingRequestedAt: isTime,
};

function workerState(value: unknown): WorkerState | null {
  if (!record(value)) return null;
  const broken = Object.entries(RULES).some(
    ([field, valid]) => value[field] !== undefined && !valid(value[field])
  );
  if (broken) return null;
  const { hostKey, hostKeyPinnedAt, parkedAt, origin, t3PairingRequestedAt } =
    value;
  return {
    ...(typeof hostKey === 'string' ? { hostKey } : {}),
    ...(isTime(hostKeyPinnedAt) ? { hostKeyPinnedAt } : {}),
    ...(isTime(parkedAt) ? { parkedAt } : {}),
    ...(origin === 'records' ? { origin } : {}),
    ...(isTime(t3PairingRequestedAt) ? { t3PairingRequestedAt } : {}),
  };
}

/** The document, or an empty one. An entry that cannot be read is dropped:
 * an unreadable pin pins nothing, so the worker is refused, never trusted.
 */
export function parseWorkerStates(text: string | null): WorkerStates {
  let value: unknown = null;
  try {
    value = text === null ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  const workers: Record<string, WorkerState> = {};
  if (record(value) && record(value['workers']))
    for (const [id, entry] of Object.entries(value['workers'])) {
      const parsed = workerState(entry);
      if (ID.test(id) && parsed) workers[id] = parsed;
    }
  return { version: 1, workers };
}

export function readWorkerStates(env = process.env): WorkerStates {
  return parseWorkerStates(
    readDocument(databasePath(stateRoot(env)), 'workers')
  );
}

/** The host keys pinned in the fleet state, by worker ID. */
export function readPins(env = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readWorkerStates(env).workers).flatMap(([id, entry]) =>
      entry.hostKey ? [[id, entry.hostKey]] : []
    )
  );
}

/** When each parked worker was parked, by worker ID. */
export function readParked(env = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readWorkerStates(env).workers).flatMap(([id, entry]) =>
      entry.parkedAt ? [[id, entry.parkedAt]] : []
    )
  );
}

function writeWorkerStates(states: WorkerStates, env = process.env): void {
  const workers = Object.fromEntries(
    Object.entries(states.workers)
      .filter(([, entry]) => Object.keys(entry).length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
  );
  writeDocument(
    databasePath(stateRoot(env)),
    'workers',
    `${JSON.stringify({ version: 1, workers }, null, 2)}\n`
  );
}

/** Changes the entries of some workers on top of the bucket's version and
 * uploads the result. `change` returns the new entry of each worker it
 * changes, or null to forget the worker.
 */
export async function changeWorkers(
  context: StateContext,
  change: (
    current: Record<string, WorkerState>
  ) => Record<string, WorkerState | null>
): Promise<{ workers: Record<string, WorkerState>; standing: Standing }> {
  const { value, standing } = await mutateState(context, () => {
    const states = readWorkerStates();
    const updates = change(states.workers);
    const workers = { ...states.workers };
    for (const [id, entry] of Object.entries(updates))
      if (entry === null) delete workers[id];
      else workers[id] = entry;
    writeWorkerStates({ version: 1, workers });
    return workers;
  });
  return { workers: value, standing };
}
