import type { TailnetComputer } from './tailscale';
import type { Check } from './types';
import { duration } from './worker-activity';

/** A parked worker is stopped or destroyed on purpose: it is listed with
 * the time since it was parked, never contacted, never the canary, and it
 * does not change the exit code. The fleet state says which ones are parked
 * (src/state/workers.ts).
 */
export function parkedCheck(id: string, parkedAt: string, now: Date): Check {
  const since = Math.max(0, (now.getTime() - Date.parse(parkedAt)) / 1000);
  return {
    id: 'worker:parked',
    status: 'not-applicable',
    summary: `${id} is parked since ${parkedAt} (${duration(since)}): it is not contacted. devfleet fleet-node-resume --id ${id} brings it back.`,
  };
}

/** What fleet-sync converges once parked workers are set aside: the fleet
 * without them (so none is contacted, expected online or made the canary)
 * and a not-applicable check for each, which never changes the exit code.
 */
export function withoutParked<
  D extends { workers: { id: string }[] },
  N extends { id: string },
>(
  definition: D,
  nodes: N[],
  parked: Record<string, string>,
  now: Date
): { definition: D; nodes: N[]; checks: Check[] } {
  return {
    definition: {
      ...definition,
      workers: definition.workers.filter((worker) => !parked[worker.id]),
    },
    nodes: nodes.filter((node) => !parked[node.id]),
    checks: definition.workers
      .filter((worker) => parked[worker.id])
      .map((worker) => parkedCheck(worker.id, parked[worker.id]!, now)),
  };
}

/** A parked worker that is online on the tailnet anyway: it costs money
 * while nobody uses it, or it was resumed by hand.
 */
export function parkedOnline(
  id: string,
  tailscaleName: string | undefined,
  computers: TailnetComputer[]
): Check | null {
  if (!tailscaleName) return null;
  const name = tailscaleName.toLowerCase();
  const online = computers.some(
    (computer) =>
      !computer.self &&
      computer.online &&
      computer.dns.toLowerCase().replace(/\.$/, '') === name
  );
  return online
    ? {
        id: 'worker:parked-online',
        status: 'warn',
        summary: `${id} is parked, and online on the tailnet.`,
        remedy: {
          action: `Stop the machine if nobody uses it (it costs money while it runs), or resume it: devfleet fleet-node-resume --id ${id}.`,
        },
      }
    : null;
}
