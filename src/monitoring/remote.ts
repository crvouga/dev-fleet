import type { Check, FleetNode, Runner } from '../types';
import { shellQuote, sshArgs, sshFailure } from '../ssh';
import { validCheck, cleanCheck } from '../protocol';
import { record } from '../config';
import { isRevision } from '../machine/state';
import type { AgentEnrollment } from './enroll';
import { remoteLockPrelude } from '../remote-lock';

/** Installs the Beszel agent on a worker. Only node-specific agent credentials
 * cross SSH; hub account credentials stay on the manager. Workers never host
 * the hub (it runs only on the manager), so there is no remote hub mode.
 * The installed source and remote operation lock are reused.
 */
export async function installRemoteAgent(
  node: FleetNode,
  revision: string,
  enrollment: AgentEnrollment,
  run: Runner
): Promise<Check[]> {
  if (!isRevision(revision)) throw new Error('BESZEL_REVISION');
  const root = `"$HOME/.local/share/personal/fleet/revisions/${revision}"`;
  const locked = shellQuote(
    JSON.stringify({
      version: 1,
      checks: [
        {
          id: 'beszel:lock',
          status: 'fail',
          summary: 'FLEET_REMOTE_LOCKED',
          remedy: {
            action:
              'Another remote operation owns the lock. Inspect its state and retry after it finishes; never delete the lock or start a competing installer.',
          },
        },
      ],
    })
  );
  const command = `cd ${root} && { ${remoteLockPrelude()} || { printf '%s\\n' ${locked}; exit 0; }; } && trap '' HUP && exec "$HOME/.local/bin/mise" exec --locked bun -- bun ${shellQuote('src/monitoring/apply.ts')}`;
  const result = await run([...sshArgs(node), command], {
    input: JSON.stringify({ ...enrollment, node: node.id, revision }),
    timeoutMs: 360_000,
  });
  if (!result.ok) return [sshFailure(result)];
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (
      record(value) &&
      value['version'] === 1 &&
      Array.isArray(value['checks']) &&
      value['checks'].length > 0 &&
      value['checks'].length <= 20 &&
      value['checks'].every(validCheck)
    )
      return value['checks'].map(cleanCheck);
  } catch {
    /* Never expose native output or credentials. */
  }
  return [
    {
      id: 'beszel:protocol',
      status: 'fail',
      summary: 'BESZEL_REMOTE_EVIDENCE_INVALID',
    },
  ];
}
