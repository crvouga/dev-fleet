import { fingerprint } from './fingerprint';
import { AUTOMATED_REPAIRS, recipe } from './repair-catalog';
import { syncWorkspace } from './sync';
import type { AutomatedRepair } from './repair-catalog';
import type { Check, Runner, Fingerprint } from './types';

export function validRepairs(value: unknown): value is AutomatedRepair[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 3 &&
    new Set(value).size === value.length &&
    value.every((id) => AUTOMATED_REPAIRS.includes(id as AutomatedRepair))
  );
}

/** Commands come exclusively from the allowlist, never from probe output or a roster. */
export async function repairWorkspace(
  root: string,
  repairs: AutomatedRepair[],
  run: Runner,
  expected?: Fingerprint
): Promise<Check[]> {
  if (!validRepairs(repairs)) throw new Error('Unsupported repairs');
  const before = await fingerprint(root, run);
  if (!before.head || !Object.values(before.files).every(Boolean))
    return [
      {
        id: 'repair:workspace',
        status: 'fail',
        summary:
          'Repairs require a complete existing checkout. Register/bootstrap it first.',
      },
    ];
  if (expected && JSON.stringify(before) !== JSON.stringify(expected))
    return [
      {
        id: 'repair:inputs',
        status: 'fail',
        summary:
          'Checkout inputs changed since diagnostics. Generate a fresh repair plan before applying.',
      },
    ];
  const checks: Check[] = [];
  for (const id of AUTOMATED_REPAIRS.filter((entry) =>
    repairs.includes(entry)
  )) {
    const result =
      id === 'workspace'
        ? await syncWorkspace(root, false, run)
        : await ownerCommand(root, id, run);
    checks.push(...result);
    if (result.some((check) => check.status !== 'pass')) break;
  }
  const after = await fingerprint(root, run);
  if (JSON.stringify(before) !== JSON.stringify(after))
    checks.push({
      id: 'repair:inputs',
      status: 'fail',
      summary:
        'Checkout inputs changed during repair. Stop and review the checkout before retrying.',
    });
  return checks;
}

async function ownerCommand(
  root: string,
  id: AutomatedRepair,
  run: Runner
): Promise<Check[]> {
  const result = await run(recipe(id).commands[0]!, {
    cwd: root,
    timeoutMs: 1_200_000,
  });
  return [
    {
      id: `repair:${id}`,
      status: result.ok ? 'pass' : 'fail',
      summary: result.ok
        ? 'The existing owner command completed. Fresh diagnostics determine whether configuration and authorization now pass.'
        : `The owner command failed (${result.reason}); partial changes are possible. Raw output and credentials are withheld. Later repairs on this computer were stopped.`,
    },
  ];
}
