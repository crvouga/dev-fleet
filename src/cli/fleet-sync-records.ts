import type { FleetDefinition, MachineDefinition } from '../definition';
import { readRosterText } from '../state/roster';
import { changeWorkers, readWorkerStates } from '../state/workers';
import { parseConfig } from '../config';
import type { Check, FleetNode, Runner } from '../types';
import {
  lifecycleServices,
  retireWorker,
  type NodeLifecycleServices,
} from './fleet-node-lifecycle';

/** The workers of the fleet as worker records describe them come and go
 * with the records: a record that appears is a declared worker, enrolled by
 * the next sync like any other; one that disappears is retired by the same
 * path as fleet-node-retire. fleet-sync calls this before it reads the
 * roster. It records which workers came from records, so that only those
 * are ever retired by themselves; a worker removed from fleet.json by hand
 * must still be retired first.
 */
export async function reconcileRecords(
  definition: FleetDefinition,
  roster: string,
  run: Runner,
  {
    apply,
    services = lifecycleServices,
  }: {
    apply: boolean;
    services?: (roster: string) => NodeLifecycleServices;
  }
): Promise<Check[]> {
  const states = readWorkerStates().workers;
  const declared = new Set(definition.workers.map((worker) => worker.id));
  const vanished = Object.entries(states)
    .filter(([id, entry]) => entry.origin === 'records' && !declared.has(id))
    .map(([id]) => id);
  const entries = await rosterEntries(roster);
  const lifecycle = { ...services(roster), run };
  const checks: Check[] = [];
  for (const id of vanished) {
    const retired = await retireWorker(
      gone(id, entries.get(id)),
      entries.get(id),
      lifecycle,
      apply
    );
    const steps = (retired.data as { nodes: { checks: Check[] }[] }).nodes[0]!
      .checks;
    const failed = steps.filter((step) => step.status === 'fail');
    checks.push(
      failed.length
        ? {
            id: 'enrollment:record',
            status: 'fail',
            summary: 'WORKER_RECORD_RETIREMENT_FAILED',
            remedy: {
              action: `${id}'s worker record disappeared, and retiring it failed at ${failed.map((step) => step.id).join(', ')}. Follow that remedy, then run fleet-sync again.`,
            },
          }
        : {
            id: 'enrollment:record',
            status: apply ? 'pass' : 'skip',
            summary: `${apply ? '' : 'Planned: '}${id}'s worker record disappeared, so it is retired: ${steps.map((step) => step.id).join(', ')}.`,
          }
    );
  }
  const fresh = definition.workers.filter(
    (worker) => worker.origin === 'records' && !states[worker.id]?.origin
  );
  if (apply && fresh.length)
    await changeWorkers(lifecycle.state(), (current) =>
      Object.fromEntries(
        fresh.map((worker) => [
          worker.id,
          { ...current[worker.id], origin: 'records' as const },
        ])
      )
    );
  return checks;
}

async function rosterEntries(path: string): Promise<Map<string, FleetNode>> {
  const text = await readRosterText(path).catch(() => null);
  if (text === null) return new Map();
  try {
    return new Map(
      parseConfig(JSON.parse(text) as unknown).nodes.map((node) => [
        node.id,
        node,
      ])
    );
  } catch {
    return new Map();
  }
}

/** A worker whose record is gone, as far as retiring it needs: reached from
 * declared data (so its pin is the fleet state's), under the name the roster
 * last knew. Its user and ports are never used to retire it.
 */
function gone(id: string, entry: FleetNode | undefined): MachineDefinition {
  return {
    id,
    os: 'linux',
    origin: 'records',
    network: {
      tailscaleName: entry?.ssh ?? id,
      user: 'root',
      sshPort: 22,
      t3Port: 3773,
    },
  };
}
