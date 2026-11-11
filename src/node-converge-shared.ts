import { fingerprint, writeReceipt } from './fingerprint';
import { configureWorkspace } from './configure';
import { stableWorkspace } from './platform/t3-policy';
import type { Check, Runner } from './types';

/** Phase wrapper: one failure code per phase, durations measured, no exception text. */
export async function attempt(
  id: string,
  operation: () => Promise<Check[]>
): Promise<Check[]> {
  const started = Date.now();
  try {
    const checks = await operation();
    const phaseDurationMs = Date.now() - started;
    return checks.map((check) => ({ ...check, phaseDurationMs }));
  } catch {
    return [
      {
        id,
        status: 'fail',
        summary: 'REMOTE_PHASE_FAILED',
        phaseDurationMs: Date.now() - started,
        remedy: {
          action:
            'Inspect the named owner and approved source revision. Prior phase evidence is retained; no exception, environment or auth response is logged.',
        },
      },
    ];
  }
}

/** The `devfleet` launcher (linked to the applied revision, never copied) and
 * this worker's own credential refresh. Identical on Linux and macOS.
 */
export async function configureWorkstation(
  root: string,
  run: Runner
): Promise<Check[]> {
  const installed = await run(
    // The stable path of the applied revision: it survives pruning.
    ['sh', 'bootstrap/install-launcher.sh', await stableWorkspace(root)],
    { cwd: root, timeoutMs: 30_000 }
  );
  if (!installed.ok)
    return [
      {
        id: 'workstation:installation',
        status: 'fail',
        summary: 'LAUNCHER_INSTALLATION_FAILED',
      },
    ];
  // This receipt certifies only frozen dependency inputs, never machine readiness.
  await writeReceipt(root, await fingerprint(root, run));
  await run(['bun', 'bootstrap/worker-auth.ts'], {
    cwd: root,
    timeoutMs: 90_000,
  });
  return [
    {
      id: 'workstation:configuration',
      status: 'pass',
      summary:
        'The devfleet launcher is linked to the applied revision; authentication remains a separate gate.',
    },
  ];
}

export function applyAgentProfiles(
  root: string,
  node: string,
  revision: string,
  run: Runner
): Promise<Check[]> {
  return configureWorkspace(
    root,
    { node, revision, tool: 'codex', profile: 'proxy' },
    run,
    {
      additionalTools: ['claude', 'gemini', 'opencode', 'grok', 'antigravity'],
      bootstrappedDeployment: true,
    }
  );
}
