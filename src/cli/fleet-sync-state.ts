import type { Enrollment } from '../machine/state';
import { replicaCheck } from '../state/check';
import { storeEnrollment } from '../state/enrollment';
import { pending, push, type Standing, type StateContext } from '../state/sync';
import type { Check } from '../types';

/** What one fleet-sync run records in the fleet state: the revision it was
 * approved for, then what it applied, then an upload so the bucket holds both.
 */
export interface RunRecord {
  /** Before any machine changes: this revision is the approved one. */
  approve(): void;
  /** Once the result is known. The check says whether the bucket holds it. */
  settle(converged: boolean): Promise<Check>;
  /** For a run that stopped before its result: its approval is still uploaded. */
  abandon(): Promise<void>;
}

export function runRecord(
  previous: Enrollment | null,
  revision: string,
  state: { context: StateContext; standing: Standing; env?: NodeJS.ProcessEnv }
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
    approve: () => storeEnrollment(approval, env),
    async settle(converged) {
      settled = true;
      if (converged)
        storeEnrollment(
          {
            ...approval,
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
