import { blocking, type Check, type FleetNode, type Runner } from '../types';
import { inspectRemote } from '../transport';
import type { CommandOutcome } from '../cli/contracts';

export interface Propagation {
  /** The enrolled workers. */
  nodes: FleetNode[];
  /** The approved revision every worker runs. */
  revision: string;
  /** The bundled remote entry sent to each worker. */
  source: string;
  /** The manager's own account instances, applied locally. */
  manager: () => Promise<Check[]>;
  run: Runner;
}

/** `fleet-sync --only accounts`: the account-derived configuration and
 * nothing else, on the manager and on every worker at once. Each node
 * re-reads the proxy's roster and rewrites only its per-account T3
 * instances; T3 watches its settings, so nothing restarts and no running
 * turn ends. Instance ids derive from the account's routing prefix, so they
 * stay the same and existing threads keep working. A node that cannot be
 * reached is reported; it catches up on the next propagation or sync, and
 * reports the roster version it has (`accounts:roster-current`) until then.
 */
export async function propagateAccounts(
  input: Propagation
): Promise<CommandOutcome> {
  const started = Date.now();
  const [manager, ...workers] = await Promise.all([
    input.manager().then((checks) => ({ node: 'manager', checks })),
    ...input.nodes.map((node) =>
      inspectRemote(
        node,
        {
          source: input.source,
          timeoutMs: 180_000,
          action: 'accounts',
          expected: { head: input.revision, files: {} },
        },
        input.run
      )
    ),
  ]);
  const nodes = [manager!, ...workers].map((report) => ({
    node: report.node,
    checks: report.checks,
  }));
  const ok = nodes.every((node) => !node.checks.some(blocking));
  return {
    exitCode: ok ? 0 : 1,
    data: {
      version: 1,
      command: 'fleet-sync',
      only: 'accounts',
      ok,
      revision: input.revision,
      durationMs: Date.now() - started,
      nodes,
    },
  };
}
