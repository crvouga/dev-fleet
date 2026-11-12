import policy from '../ansible/ubuntu/policy.json';

/** How much of a machine a worker needs, and the lines its disk and memory
 * policy draws, all declared under `sizing` in ansible/ubuntu/policy.json.
 * Each line is a share of the disk or of memory between a lower and an upper
 * bound, so it scales from a small rented instance to a large workstation.
 * `tasks/sizing.yml` computes the same numbers for Ansible.
 */
export type ThresholdName = keyof typeof policy.sizing.thresholds;

export interface MachineSize {
  memoryMiB: number;
  /** The size of the root filesystem (or the home one, for its own lines). */
  diskMiB: number;
  cpus: number;
}

/** One line in MiB for a machine whose disk or memory (as the line says)
 * is `totalMiB`: its share, never under its lower bound or over its upper. */
export function threshold(name: ThresholdName, totalMiB: number): number {
  const line = policy.sizing.thresholds[name];
  return Math.min(
    line.maxMiB,
    Math.max(line.minMiB, Math.floor(line.share * totalMiB))
  );
}

/** Every line, for a machine of this size. */
export function thresholds(size: {
  memoryMiB: number;
  diskMiB: number;
}): Record<ThresholdName, number> {
  return Object.fromEntries(
    (Object.keys(policy.sizing.thresholds) as ThresholdName[]).map((name) => [
      name,
      threshold(
        name,
        policy.sizing.thresholds[name].of === 'memory'
          ? size.memoryMiB
          : size.diskMiB
      ),
    ])
  ) as Record<ThresholdName, number>;
}

export const MINIMUM_WORKER: MachineSize = policy.sizing.minimumWorker;

/** What a machine lacks to be a worker, each as `memory 2048 MiB < 3584
 * MiB`; empty when it has the stated minimum. */
export function belowMinimum(size: MachineSize): string[] {
  const lacks: string[] = [];
  if (size.memoryMiB < MINIMUM_WORKER.memoryMiB)
    lacks.push(
      `memory ${size.memoryMiB} MiB < ${MINIMUM_WORKER.memoryMiB} MiB`
    );
  if (size.diskMiB < MINIMUM_WORKER.diskMiB)
    lacks.push(`disk ${size.diskMiB} MiB < ${MINIMUM_WORKER.diskMiB} MiB`);
  if (size.cpus < MINIMUM_WORKER.cpus)
    lacks.push(`CPUs ${size.cpus} < ${MINIMUM_WORKER.cpus}`);
  return lacks;
}

/** The user workloads' share of memory, from `userMemoryMax` ("90%"). */
function userShare(): number {
  const percent = /^(\d{1,3})%$/.exec(policy.resourceSafety.userMemoryMax);
  return percent ? Number(percent[1]) / 100 : 1;
}

/** How many agent sessions run side by side within the memory policy:
 * what user workloads may use, less what T3 keeps for itself, in sessions
 * of the estimated size `sizing.agentSessionMiB`. Never below zero.
 */
export function supportedSessions(memoryMiB: number): number {
  const usable = memoryMiB * userShare() - policy.sizing.t3ReservedMiB;
  return Math.max(0, Math.floor(usable / policy.sizing.agentSessionMiB));
}
