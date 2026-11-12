import { checkOwner } from './check-owners';
import { AUTOMATED_REPAIRS, recipe } from './repair-catalog';
import type { RepairRecipe } from './repair-catalog';
import type { Check, FleetNode, NodeReport, Fingerprint } from './types';

export interface RepairTarget {
  name: string;
  root: string;
  node?: FleetNode;
  fingerprint?: Fingerprint;
}
export interface RepairStep extends RepairRecipe {
  node: string;
  checks: string[];
  eligible: boolean;
  next: string[];
  /** For work left to a person: why no recipe does it, per check. */
  manual?: { check: string; reason: string }[];
}

export function repairId(check: Check): string {
  const owner = checkOwner(check.id);
  if (!owner?.repair) return 'operator';
  return owner.repair === 'login:*'
    ? `login:${check.id.slice('auth:'.length)}`
    : owner.repair;
}

/** Why a check is left to a person, or null when a recipe repairs it. */
export function manualReason(check: Check): string | null {
  const owner = checkOwner(check.id);
  if (owner?.repair) return null;
  return (
    owner?.manual ??
    'No repair recipe is registered for this check: follow its remedy.'
  );
}

/** Every nonpassing check is accounted for; unknown checks remain operator work. */
export function repairPlan(
  reports: NodeReport[],
  targets: RepairTarget[]
): RepairStep[] {
  const steps: RepairStep[] = [];
  for (const report of reports) {
    const groups = new Map<string, Check[]>();
    for (const check of report.checks.filter(
      (entry) => entry.status !== 'pass'
    )) {
      const repair = recipe(repairId(check)).id;
      groups.set(repair, [...(groups.get(repair) ?? []), check]);
    }
    for (const [id, checks] of groups) {
      const manual = checks.flatMap((check) => {
        const reason = manualReason(check);
        return reason ? [{ check: check.id, reason }] : [];
      });
      steps.push({
        ...recipe(id),
        ...(manual.length ? { manual } : {}),
        node: report.node,
        eligible:
          targets.some((target) => target.name === report.node) &&
          report.snapshot !== undefined,
        checks: checks.map((check) => check.id),
        next: [
          ...new Set(
            checks.flatMap((check) =>
              check.remedy ? [check.remedy.action] : [check.summary]
            )
          ),
        ],
      });
    }
  }
  return steps;
}

/** Prerequisite owners always run first, independent of check or selector order. */
export function automaticRepairs(
  steps: RepairStep[],
  node: string
): RepairStep[] {
  return AUTOMATED_REPAIRS.flatMap((id) =>
    steps.filter(
      (step) =>
        step.node === node && step.id === id && step.automatic && step.eligible
    )
  );
}
