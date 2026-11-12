import { parseConfig } from '../config';
import { STATE_ROSTER, readRosterText, writeRosterText } from '../state/roster';
import { mutateState, stateContext, type StateContext } from '../state/sync';
import { changeWorkers, readWorkerStates } from '../state/workers';
import type { Check, FleetNode, Runner } from '../types';
import { pairWorker, pairingCheck, type ManagerT3 } from './peer-link';

/** Records the T3 environment a worker runs in the roster, the first time a
 * verified link from the manager reaches it. From then on the link check
 * compares against this identity, so a worker whose T3 data was replaced is
 * told apart from one that is only offline. An identity already recorded is
 * never rewritten.
 */
export async function rememberEnvironment(
  path: string,
  node: string,
  environmentId: string,
  context: () => StateContext = stateContext
): Promise<boolean> {
  const save = async (): Promise<boolean> => {
    const text = await readRosterText(path);
    if (text === null) return false;
    const roster = parseConfig(JSON.parse(text) as unknown);
    const entry = roster.nodes.find((candidate) => candidate.id === node);
    if (!entry || entry.t3EnvironmentId) return false;
    entry.t3EnvironmentId = environmentId;
    // Parsing again refuses an identity that is not a T3 environment ID.
    const next = parseConfig(roster);
    await writeRosterText(path, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  };
  if (path !== STATE_ROSTER) return save();
  return (await mutateState(context(), save)).value;
}

/** What pairing a worker needs: where the roster is, how commands run, the
 * manager's T3 and the fleet state. */
export interface PairingServices {
  roster: string;
  run: Runner;
  manager: ManagerT3;
  context: () => StateContext;
  now: () => Date;
}

/** Pairs the manager's T3 with the environment a worker runs now, without a
 * person (src/t3/peer-link.ts), and records it in the roster. Until it is
 * paired, the fleet state keeps the request, so the next fleet-sync pairs
 * it once the worker's T3 runs; once paired, the request is forgotten.
 */
export async function pairAndRecord(
  node: FleetNode,
  services: PairingServices
): Promise<Check> {
  const pairing = await pairWorker(node, services.run, services.manager);
  if ('paired' in pairing)
    await rememberEnvironment(
      services.roster,
      node.id,
      pairing.paired,
      services.context
    );
  const requested = services.now().toISOString();
  await changeWorkers(services.context(), (current) => {
    const { t3PairingRequestedAt: earlier, ...rest } = current[node.id] ?? {};
    return {
      [node.id]:
        'paired' in pairing
          ? rest
          : { ...rest, t3PairingRequestedAt: earlier ?? requested },
    };
  });
  return pairingCheck(node.id, pairing);
}

/** fleet-sync's part: pairs a worker only when fleet-node-replace asked for
 * it. A worker enrolled for the first time is paired by a person.
 */
export async function pairIfRequested(
  node: FleetNode,
  services: Omit<PairingServices, 'context' | 'now'> &
    Partial<Pick<PairingServices, 'context'>>
): Promise<Check | undefined> {
  if (!readWorkerStates().workers[node.id]?.t3PairingRequestedAt) return;
  return pairAndRecord(node, {
    context: () => stateContext(services.run),
    ...services,
    now: () => new Date(),
  });
}
