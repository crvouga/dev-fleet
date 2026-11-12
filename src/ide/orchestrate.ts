import type { Check, FleetNode } from '../types';
import type { Ide, MachineContext, WorkerContext } from './ide';

/** The implementations the fleet enables, in the order it names them. An ID
 * nobody implements is refused before anything runs.
 */
export function enabled(
  ids: readonly string[],
  registry: Readonly<Record<string, Ide>>
): Ide[] {
  return ids.map((id) => {
    const ide = registry[id];
    if (!ide) throw new Error(`Unsupported IDE: ${id}`);
    return ide;
  });
}

export async function settingsChecks(
  ides: Ide[],
  context: MachineContext
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const ide of ides) checks.push(...(await ide.settings(context)));
  return checks;
}

export async function managerChecks(
  ides: Ide[],
  context: MachineContext
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const ide of ides) checks.push(...(await ide.manager(context)));
  return checks;
}

export async function workerChecks(
  ides: Ide[],
  node: FleetNode,
  context: WorkerContext
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const ide of ides)
    checks.push(
      ...(await ide.worker(node, {
        ...context,
        earlier: [...context.earlier, ...checks],
      }))
    );
  return checks;
}
