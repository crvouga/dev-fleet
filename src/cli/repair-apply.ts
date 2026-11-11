import { automaticRepairs } from '../repair-plan';
import { mapBounded } from '../report';
import { repairWorkspace } from '../repair-runner';
import { inspectRemote } from '../transport';
import { timeout } from './options';
import type { AutomatedRepair } from '../repair-catalog';
import type { RepairTarget, RepairStep } from '../repair-plan';
import type { NodeReport } from '../types';
import type { CliOptions } from './options';
import type { FleetServices } from './fleet';

export async function applyRepairs(
  targets: RepairTarget[],
  steps: RepairStep[],
  options: CliOptions,
  services: FleetServices
): Promise<NodeReport[]> {
  let source: Promise<string> | undefined;
  return mapBounded(
    targets,
    async (target) => {
      const actions = automaticRepairs(steps, target.name);
      const checks: NodeReport['checks'] = [];
      for (const step of actions) {
        try {
          if (!target.fingerprint)
            throw new Error('No verified checkout fingerprint');
          const repairs = [step.id as AutomatedRepair];
          const result = target.node
            ? (
                await inspectRemote(
                  target.node,
                  {
                    action: 'repair',
                    repairs,
                    expected: target.fingerprint,
                    source: await (source ??= Promise.resolve().then(
                      services.source
                    )),
                    timeoutMs: timeout(options),
                  },
                  services.run
                )
              ).checks
            : await repairWorkspace(
                target.root,
                repairs,
                services.run,
                target.fingerprint
              );
          checks.push(...result);
          if (result.some((check) => check.status !== 'pass')) break;
        } catch {
          checks.push({
            id: 'repair:operation',
            status: 'fail',
            summary:
              'Repair could not be prepared or completed. Later actions on this computer were stopped; inspect partial changes locally. Raw errors are withheld.',
          });
          break;
        }
      }
      return { node: target.name, checks };
    },
    1
  );
}
