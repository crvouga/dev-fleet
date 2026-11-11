import { diagnostic } from './diagnostics';
import type { FleetDefinition } from './definition';
import type { ManagerReport } from './manager-sync';
import type { Check } from './types';

/** Even preflight failures account for every declared target, without discovery,
 * authentication, filesystem mutations or accidental target substitution.
 */
export function managerFailure(
  definition: FleetDefinition,
  revision: string | null,
  code: string,
  action: string
): ManagerReport {
  const check: Check = {
    id: 'manager:preflight',
    status: 'fail',
    summary: code,
    remedy: { action },
  };
  return {
    version: 3,
    command: 'fleet-sync',
    execution: 'manager-push',
    ok: false,
    applied: false,
    desiredRevision: revision,
    checks: [check],
    candidates: 0,
    dashboardUrl: null,
    nodes: definition.workers.map((node) => ({
      node: node.id,
      diagnostics: [diagnostic(node.id, check)],
      reachability: 'unknown',
      desiredRevision: revision,
      appliedRevision: null,
      durationMs: 0,
      checks: [
        {
          id: 'rollout:prerequisites',
          status: 'skip',
          summary: code,
          remedy: { action },
        },
      ],
    })),
  };
}
