import type { Enrollment } from '../machine/state';
import { replicaCheck } from '../state/check';
import { storeEnrollment } from '../state/enrollment';
import { adoptEarlier } from '../state/legacy';
import { databasePath, stateRoot } from '../state/paths';
import { writeDocument } from '../state/store';
import {
  claimLease,
  refuseHeldLease,
  pending,
  push,
  type Standing,
  type StateContext,
} from '../state/sync';
import type { Check } from '../types';

/** What one fleet-sync run records in the fleet state: the revision it was
 * approved for and the configuration it runs with, then what it applied, then
 * an upload so the bucket holds all of it.
 */
export interface RunRecord {
  /** Before any machine changes: this revision is the approved one. */
  approve(): void;
  /** Once the result is known. The check says whether the bucket holds it.
   * `applied` is the revision each worker that converged now holds: it is
   * kept even when the fleet as a whole is not ready.
   */
  settle(converged: boolean, applied?: Record<string, string>): Promise<Check>;
  /** For a run that stopped before its result: its approval is still uploaded. */
  abandon(): Promise<void>;
}

export function runRecord(
  previous: Enrollment | null,
  revision: string,
  state: {
    context: StateContext;
    standing: Standing;
    env?: NodeJS.ProcessEnv;
    /** The configuration this run reads from a project's fleet.json. Stored
     * so that a run started anywhere else (the schedule, a hand-off from a
     * worker, a replacement manager) uses the one last applied.
     */
    definition?: string;
  }
): RunRecord {
  const env = state.env ?? process.env;
  const approval: Enrollment = {
    ...previous,
    version: 1,
    id: 'manager',
    approvedRevision: revision,
  };
  let settled = false;
  /** Uploads only what this run changed; otherwise the bucket stands as it
   * did when the run started.
   */
  const publish = (): Promise<Standing> =>
    pending(state.context)
      ? push(state.context)
      : Promise.resolve(state.standing);
  return {
    approve: () => {
      refuseHeldLease(state.context);
      storeEnrollment(approval, env);
      if (state.definition !== undefined) {
        adoptEarlier(env);
        writeDocument(
          databasePath(stateRoot(env)),
          'definition',
          state.definition
        );
      }
      claimLease(state.context);
    },
    async settle(converged, applied = {}) {
      settled = true;
      const workers = Object.keys(applied).length
        ? { workers: { ...previous?.workers, ...applied } }
        : {};
      if (!converged && workers.workers)
        storeEnrollment({ ...approval, ...workers }, env);
      if (converged)
        storeEnrollment(
          {
            ...approval,
            ...workers,
            appliedRevision: revision,
            ...(previous?.appliedRevision &&
            previous.appliedRevision !== revision
              ? { previousRevision: previous.appliedRevision }
              : {}),
          },
          env
        );
      // The fleet converged either way: a bucket problem is reported, not fatal.
      return replicaCheck(await publish().catch(() => 'unreachable' as const), {
        advisory: true,
      });
    },
    async abandon() {
      if (!settled) await publish().catch(() => undefined);
    },
  };
}
