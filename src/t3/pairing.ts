import { parseConfig } from '../config';
import { STATE_ROSTER, readRosterText, writeRosterText } from '../state/roster';
import { mutateState, stateContext, type StateContext } from '../state/sync';

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
