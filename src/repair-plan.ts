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
}

export function repairId(check: Check): string {
  if (check.id.startsWith('tool:docker-')) return 'docker';
  if (check.id.startsWith('tool:github-auth')) return 'login:github';
  if (['dependencies', 'auth:toolchain'].includes(check.id)) return 'workspace';
  if (check.id.startsWith('tool:')) return 'workspace';
  if (check.id.startsWith('workstation:')) return 'workstation';
  if (
    check.id.startsWith('auth:') &&
    !['auth:vscode', 'auth:workstation'].includes(check.id)
  )
    return `login:${check.id.slice(5)}`;
  if (check.id === 't3:settings' || check.id === 't3:api') return 't3';
  return 'operator';
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
    for (const [id, checks] of groups)
      steps.push({
        ...recipe(id),
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
