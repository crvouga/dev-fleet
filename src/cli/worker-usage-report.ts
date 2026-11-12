import { fleet } from '../fleet-config';
import { readParked } from '../state/workers';
import type { TailnetComputer } from '../tailscale';
import type { FleetNode, NodeReport, Runner } from '../types';
import { fleetUsage, usageSummary, type WorkerUsage } from '../worker-activity';
import { parkedCheck, parkedOnline } from '../worker-parking';

/** The workers fleet-status contacts: every one that is not parked. */
export function activeNodes(nodes: FleetNode[]): FleetNode[] {
  const parked = readParked();
  return nodes.filter((node) => !parked[node.id]);
}

function reportOf(reports: NodeReport[], id: string): NodeReport {
  const worker = fleet.workers.find((entry) => entry.id === id);
  const found = reports.find(
    (entry) =>
      entry.node === id ||
      (worker?.network && entry.node === worker.network.tailscaleName)
  );
  if (found) return found;
  const added: NodeReport = { node: id, checks: [] };
  reports.push(added);
  return added;
}

/** Adds to fleet-status what it says about each worker beyond its health:
 * parked workers as parked (and a warning when one is online anyway), and
 * for every active worker it reaches its uptime, agent turns, last agent
 * activity and `worker:idle`. Returns the `workers` of the JSON output and
 * its `usage` summary.
 */
export async function appendUsage(
  reports: NodeReport[],
  nodes: FleetNode[],
  {
    run,
    computers = [],
    now = new Date(),
  }: { run: Runner; computers?: TailnetComputer[]; now?: Date }
): Promise<{ workers: WorkerUsage[]; usage: ReturnType<typeof usageSummary> }> {
  const parked = readParked();
  for (const worker of fleet.workers) {
    const at = parked[worker.id];
    if (!at) continue;
    const report = reportOf(reports, worker.id);
    report.checks.push(parkedCheck(worker.id, at, now));
    const online = parkedOnline(
      worker.id,
      worker.network?.tailscaleName,
      computers
    );
    if (online) report.checks.push(online);
  }
  const { workers, checks } = await fleetUsage(fleet, {
    nodes: nodes.filter((node) => !parked[node.id]),
    parked,
    run,
    now,
  });
  for (const [id, check] of checks) reportOf(reports, id).checks.push(check);
  return { workers, usage: usageSummary(workers) };
}
