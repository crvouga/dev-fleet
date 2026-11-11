import { record } from './config';
import { configPath } from './fleet-config';
import type { Check, Runner } from './types';

/** The proxy runs only on the manager, which performs singleton/state/provenance
 * checks before starting a stopped install; on a worker this verifies the
 * client-only role. Routine sync cannot upgrade or restore it.
 */
export async function convergeProxy(
  node: string,
  revision: string,
  run: Runner,
  options: { apply?: boolean; cwd?: string } = {}
): Promise<Check[]> {
  const result = await run(
    [
      'python3',
      '-B',
      'cliproxy/scripts/fleet_sync.py',
      '--definition',
      configPath(),
      '--node',
      node,
      '--revision',
      revision,
      ...(options.apply === false ? [] : ['--apply']),
    ],
    {
      timeoutMs: 180_000,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    }
  );
  try {
    const data: unknown = JSON.parse(result.stdout);
    if (
      !record(data) ||
      data['version'] !== 1 ||
      !Array.isArray(data['phases']) ||
      !data['phases'].length
    )
      throw new Error();
    return data['phases'].map((phase): Check => {
      if (
        !record(phase) ||
        typeof phase['code'] !== 'string' ||
        !/^PROXY_[A-Z0-9_]+$/.test(phase['code'])
      )
        throw new Error();
      return {
        id: `proxy:${phase['code'].slice(6).toLowerCase().replaceAll('_', '-')}`,
        status: phase['status'] === 'unchanged' ? 'pass' : 'fail',
        summary: phase['code'],
        remedy: { action: phaseAction(phase['remedy']) },
      };
    });
  } catch {
    return [
      {
        id: 'proxy:configuration',
        status: 'fail',
        summary: 'PROXY_RECONCILE_UNVERIFIED',
        remedy: {
          action:
            'Inspect the CLIProxyAPI install on the manager and its deployment manifest; runtime data and credentials were not copied.',
        },
      },
    ];
  }
}

const GENERIC_ACTION =
  'The proxy runs only on the manager. Inspect it there with its audit/recovery runbook; missing state requires fencing and encrypted recovery, never a second identity.';

/** The proxy's own remedies are authored text from tracked source (never
 * subprocess output); anything else falls back to the generic runbook.
 */
function phaseAction(remedy: unknown): string {
  const action = record(remedy) ? remedy['action'] : undefined;
  return typeof action === 'string' &&
    action.length > 0 &&
    action.length <= 400 &&
    !/[\u0000-\u001f]/.test(action)
    ? action
    : GENERIC_ACTION;
}
