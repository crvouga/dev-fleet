import { createHash } from 'node:crypto';
import type { RepairStep, RepairTarget } from '../repair-plan';

export function repairPlanHash(
  steps: RepairStep[],
  targets: RepairTarget[]
): string {
  return createHash('sha256')
    .update(JSON.stringify({ steps, targets }))
    .digest('hex');
}
