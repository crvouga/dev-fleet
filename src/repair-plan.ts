import { checkOwner } from './check-owners';
import { AUTOMATED_REPAIRS, REPAIR_RECIPES, recipe } from './repair-catalog';
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

const UNOWNED =
  'No repair recipe is registered for this check: follow its remedy.';

/** What repairs a check: the recipe its owner names, or why only a person
 * can. An `auth:` check is repaired by the login recipe of its name; one
 * with no such recipe is a person's, for the reason `login:*` gives. */
export function checkRepair(
  id: string
): { recipe: string } | { manual: string } {
  const owner = checkOwner(id);
  if (!owner?.repair) return { manual: owner?.manual ?? UNOWNED };
  if (owner.repair !== 'login:*') return { recipe: owner.repair };
  const login = `login:${id.slice('auth:'.length)}`;
  return REPAIR_RECIPES.some((entry) => entry.id === login)
    ? { recipe: login }
    : { manual: checkOwner(login)?.manual ?? UNOWNED };
}

export function repairId(check: Check): string {
  const repair = checkRepair(check.id);
  return 'recipe' in repair ? repair.recipe : 'operator';
}

/** Why a check is left to a person, or null when a recipe repairs it. */
export function manualReason(check: Check): string | null {
  const repair = checkRepair(check.id);
  return 'manual' in repair ? repair.manual : null;
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
