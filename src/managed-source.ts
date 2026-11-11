import { sshArgs } from './ssh';
import { isRevision } from './machine/state';
import type { Check, FleetNode, Runner } from './types';

/** Audit the immutable deployed revision, never confuse it with a developer checkout. */
export async function managedProbeTarget(
  node: FleetNode,
  revision: string | null,
  run: Runner
): Promise<{ node: FleetNode; checks: Check[] }> {
  if (!node.required.includes('worker') || !isRevision(revision))
    return { node, checks: [] };
  const result = await run(
    [
      ...sshArgs(node),
      `d="$HOME/.local/share/personal/fleet/revisions/${revision}"; test ! -L "$d" && test -d "$d/.git" && test "$(git -C "$d" rev-parse HEAD 2>/dev/null)" = '${revision}' && test "$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" = "$d" && clean=$(git -C "$d" status --porcelain 2>/dev/null) && test -z "$clean" && printf '%s' "$d"`,
    ],
    { timeoutMs: 15_000 }
  );
  if (!result.ok || !/^\/[^\x00-\x1f\x7f]{1,4000}$/.test(result.stdout))
    return {
      node,
      checks: [
        {
          id: 'worker:desired-source',
          status: 'fail',
          summary:
            'The declared immutable worker revision has not been deployed. Developer checkout diagnostics follow separately.',
          remedy: {
            action:
              'Run fleet-sync for this exact release/revision; developer branches and dirty work are never reset.',
          },
        },
      ],
    };
  return {
    node: { ...node, workspace: result.stdout },
    checks: [
      {
        id: 'worker:desired-source',
        status: 'pass',
        summary:
          'Auditing the deployed immutable revision, independently of the developer checkout.',
      },
    ],
  };
}
