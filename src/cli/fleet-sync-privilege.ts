import type { Check, FleetNode, Runner } from '../types';
import { sshArgs, sshFailure } from '../ssh';

/** Initial enrollment must establish sudo once. Routine convergence never asks for passwords. */
export async function authorizePrivilege(
  node: FleetNode,
  _script: string | undefined,
  run: Runner
): Promise<Check[]> {
  const existing = await run([...sshArgs(node), 'sudo -n true'], {
    timeoutMs: 15_000,
  });
  if (existing.ok) return [];
  if (existing.reason !== 'exit' || !/sudo:/i.test(existing.stderr))
    return [sshFailure(existing)];
  return [
    {
      id: 'bootstrap:privilege',
      status: 'fail',
      summary: 'SUDO_AUTHORIZATION_REQUIRED',
      remedy: {
        action:
          'Use the source-owned ansible/ubuntu/authorize-sudo.sh once during initial administrator enrollment. Runtime convergence requires sudo -n and never prompts for or stores a password.',
      },
    },
  ];
}
