import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import macos from '../../ansible/macos/policy.json';
import { runAnsibleWithReceipt } from '../platform/ansible-receipt';
import { privateHub } from './beszel';
import type { AgentEnrollment } from './enroll';
import type { Check, Runner } from '../types';

/** Installs the manager's own Beszel agent locally (never over SSH) as a
 * per-user launchd agent, so the manager is always a system on its own hub.
 * No sudo: fleet-sync on the manager stays unattended.
 */
export async function installManagerAgent(
  root: string,
  { node, enrollment }: { node: string; enrollment: AgentEnrollment },
  run: Runner,
  { uid = userInfo().uid, directory }: { uid?: number; directory?: string } = {}
): Promise<Check[]> {
  const monitoring = resolve(root, 'ansible/monitoring');
  const result = await runAnsibleWithReceipt(
    run,
    'agent-darwin.yml',
    {
      cwd: monitoring,
      timeoutMs: 300_000,
      input: JSON.stringify({
        beszel_node: node,
        beszel_hub_url: privateHub(enrollment.hubUrl),
        beszel_public_key: enrollment.publicKey,
        beszel_agent_token: enrollment.token,
      }),
    },
    {
      name: 'beszel-manager-agent',
      sources: [monitoring, resolve(root, 'ansible/macos')],
      verify: async () => agentRunning(run, uid),
      ...(directory ? { directory } : {}),
    }
  );
  if (!result.ok)
    return [
      {
        id: 'beszel:installation',
        status: 'fail',
        summary: 'BESZEL_INSTALLATION_INCOMPLETE',
        remedy: {
          action:
            'Inspect signed artifact access, free disk and ~/Library/LaunchAgents on the manager. A leftover root daemon must be removed once (sudo launchctl bootout system/' +
            macos.beszelDaemon +
            '). Agent data under ~/Library/Application Support/personal-beszel-agent is preserved.',
        },
      },
    ];
  const running = await agentRunning(run, uid);
  return [
    {
      id: 'beszel:service',
      status: running ? 'pass' : 'fail',
      summary: running
        ? 'The manager runs its own Beszel agent as an always-on launch agent; hub metrics remain a separate gate.'
        : 'BESZEL_SERVICE_STOPPED',
    },
  ];
}

async function agentRunning(run: Runner, uid: number): Promise<boolean> {
  const state = await run([
    '/bin/launchctl',
    'print',
    `gui/${uid}/${macos.beszelDaemon}`,
  ]);
  return state.ok && /state = running/.test(state.stdout);
}
