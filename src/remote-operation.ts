import { record } from './config';
import { cleanCheck, validCheck } from './protocol';
import { sshArgs, sshFailure } from './ssh';
import type { Check, CommandResult, FleetNode, Runner } from './types';

/** How the manager waits: a pause, and the time now. Tests answer both. */
export interface Clock {
  pause(ms: number): Promise<void>;
  now(): number;
}

export const realClock: Clock = {
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** A session that could not be opened, or was lost, is tried again after
 * these pauses: three attempts over thirty seconds.
 */
export const RETRY_PAUSES_MS = [10_000, 20_000];
/** How often an operation the manager follows is looked at again. */
export const FOLLOW_EVERY_MS = 15_000;
/** As long as a bootstrap may run. */
export const FOLLOW_AT_MOST_MS = 5_400_000;

/** Failures of the connection, not of the worker: worth another attempt. A
 * changed host key, a refused login or an unknown name never are.
 */
export function transient(result: CommandResult): boolean {
  if (result.ok) return false;
  const { id } = sshFailure(result);
  return ['ssh:disconnected', 'ssh:network', 'ssh:timeout'].includes(id);
}

/** Runs a short SSH session, again after a pause while its connection fails. */
export async function retrying(
  attempt: () => Promise<CommandResult>,
  clock: Clock
): Promise<CommandResult> {
  let result = await attempt();
  for (const pause of RETRY_PAUSES_MS) {
    if (!transient(result)) return result;
    await clock.pause(pause);
    result = await attempt();
  }
  return result;
}

/** What a worker says about the fleet operation on it. */
export interface Operation {
  /** The operation lock is held by a running process. */
  held: boolean;
  /** The process that recorded the operation is still running. */
  alive: boolean;
  revision: string | null;
  phase: string | null;
  /** Seconds since the epoch, on the worker's clock. */
  started: number | null;
  finished: boolean;
  /** What node convergence reported, once the operation finished. */
  result: Check[] | null;
}

/** Read-only. Prints whether the lock is held, whether the recorded process
 * runs, the operation record and its result, one per line. Holding the lock
 * for a moment to test it is not possible while another holds it, and takes
 * nothing from anyone when nobody does.
 */
export const OPERATION_PROBE = [
  'r="$HOME/.local/share/personal/fleet"',
  'l="$r/remote-operation.lock"',
  'held=no',
  'if [ -f "$l" ] && [ ! -L "$l" ]; then if command -v flock >/dev/null 2>&1; then flock -n "$l" true || held=yes; else python3 -c \'import fcntl, sys; fcntl.flock(open(sys.argv[1], "a"), fcntl.LOCK_EX | fcntl.LOCK_NB)\' "$l" 2>/dev/null || held=yes; fi; fi',
  'op=$(head -c 4096 "$r/remote-operation.json" 2>/dev/null | head -n 1)',
  'pid=$(printf %s "$op" | sed -n \'s/.*"pid":\\([0-9][0-9]*\\).*/\\1/p\')',
  'alive=no',
  'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=yes; fi',
  'printf \'held=%s\\nalive=%s\\noperation=%s\\nresult=\' "$held" "$alive" "$op"',
  'head -c 1048576 "$r/remote-operation-result.json" 2>/dev/null | head -n 1',
  "printf '\\n'",
].join('\n');

function field(stdout: string, name: string): string | null {
  const line = stdout.split('\n').find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? null : line.slice(name.length + 1);
}

function json(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function evidence(value: unknown): Check[] | null {
  return record(value) &&
    value['version'] === 1 &&
    Array.isArray(value['checks']) &&
    value['checks'].length > 0 &&
    value['checks'].length <= 200 &&
    value['checks'].every(validCheck)
    ? value['checks'].map(cleanCheck)
    : null;
}

export function parseOperation(stdout: string): Operation | null {
  const held = field(stdout, 'held');
  const alive = field(stdout, 'alive');
  if (held === null || alive === null) return null;
  const operation = json(field(stdout, 'operation'));
  const op = record(operation) ? operation : {};
  const text = (value: unknown, pattern: RegExp): string | null =>
    typeof value === 'string' && pattern.test(value) ? value : null;
  return {
    held: held === 'yes',
    alive: alive === 'yes',
    revision: text(op['revision'], /^[a-f0-9]{40}$/),
    phase: text(op['phase'], /^[a-z0-9-]{1,40}$/),
    started: typeof op['started'] === 'number' ? op['started'] : null,
    finished: typeof op['finished'] === 'number',
    result: evidence(json(field(stdout, 'result'))),
  };
}

export async function inspectOperation(
  node: FleetNode,
  run: Runner,
  clock: Clock
): Promise<Operation | null> {
  const result = await retrying(
    () => run([...sshArgs(node), OPERATION_PROBE], { timeoutMs: 20_000 }),
    clock
  );
  return result.ok ? parseOperation(result.stdout) : null;
}

/** An operation of this revision whose process still runs: this is the run
 * the manager lost, or one another manager run started; either way it is
 * the run to follow, not one to start beside it.
 */
function followable(operation: Operation, revision: string): boolean {
  return (
    operation.held &&
    operation.alive &&
    !operation.finished &&
    operation.revision === revision
  );
}

function finishedWith(operation: Operation, revision: string): Check[] | null {
  return !operation.held &&
    operation.finished &&
    operation.revision === revision
    ? operation.result
    : null;
}

export interface Follow {
  clock?: Clock;
  /** Told the phase and how long the operation has run, at every look. */
  progress?: (phase: string) => void;
}

/** After a lost session or a held lock: the result of the operation of this
 * revision on the worker, followed to its end when it still runs. Null when
 * there is none to follow: another revision, another holder, or nothing.
 */
export async function followOperation(
  node: FleetNode,
  revision: string,
  run: Runner,
  options: Follow = {}
): Promise<Check[] | null> {
  const clock = options.clock ?? realClock;
  const deadline = clock.now() + FOLLOW_AT_MOST_MS;
  let operation = await inspectOperation(node, run, clock);
  if (!operation) return null;
  const done = finishedWith(operation, revision);
  if (done) return [attached(operation, 'finished'), ...done];
  if (!followable(operation, revision)) return null;
  let last: Operation = operation;
  while (clock.now() < deadline) {
    options.progress?.(describe(last, clock));
    await clock.pause(FOLLOW_EVERY_MS);
    operation = await inspectOperation(node, run, clock);
    if (!operation) continue;
    last = operation;
    const result = finishedWith(operation, revision);
    if (result) return [attached(operation, 'followed'), ...result];
    if (!followable(operation, revision)) return null;
  }
  return null;
}

function describe(operation: Operation, clock: Clock): string {
  const elapsed =
    operation.started === null
      ? ''
      : `, ${Math.max(0, Math.round(clock.now() / 1000 - operation.started))} s`;
  return `Following the running operation (${operation.phase ?? 'unknown phase'}${elapsed})`;
}

function attached(_operation: Operation, how: 'finished' | 'followed'): Check {
  return {
    id: 'bootstrap:attached',
    status: 'pass',
    summary:
      how === 'followed'
        ? 'The manager lost or could not take this machine’s operation of the same revision, followed it to its end and reports its result.'
        : 'This machine finished the operation of the same revision the manager lost; its result is reported.',
  };
}
