import { join } from 'node:path';
import {
  selectionArguments,
  type ToolSelection,
} from '../bootstrap/worker-tools';
import { record } from './config';
import type { Check, Runner } from './types';

export async function toolchainChecks(
  root: string,
  run: Runner,
  /** A worker's own tool selection; absent on the manager. */
  worker?: ToolSelection
): Promise<Check[]> {
  const result = await run(doctorArguments(root, worker), {
    cwd: root,
    timeoutMs: 90_000,
  });
  const fallback: Check = {
    id: 'auth:toolchain',
    status: 'fail',
    summary: 'Pinned tool/dependency and Docker checks could not be verified.',
    remedy: {
      action:
        'Run the checkout bootstrap/doctor.ts --json --docker on this computer. Reconcile versions only through the shared mise setup.',
    },
  };
  try {
    const data: unknown = JSON.parse(result.stdout);
    if (
      !record(data) ||
      typeof data['ok'] !== 'boolean' ||
      !Array.isArray(data['checks']) ||
      !data['checks'].length ||
      data['checks'].length > 150
    )
      return [fallback];
    const checks = data['checks'].map(toolCheck);
    if (checks.some((check) => check === null)) return [fallback];
    return [
      ...(!result.ok || !data['ok'] ? [fallback] : []),
      ...(checks as Check[]),
    ];
  } catch {
    return [fallback];
  }
}

/** Checks of the doctor that are not a tool version, with their own words. */
const OWN: Record<string, { pass: string; fail: string; action: string }> = {
  'global-mise-config': {
    pass: 'The global mise configuration is the one fleet-sync publishes.',
    fail: 'The global mise configuration is missing, was replaced by another project or tool, or is not the one this revision publishes.',
    action:
      'Run devfleet fleet-sync from the project that holds fleet.json. On a fleet machine the global mise configuration belongs to dev-fleet: a project pins its own tools in a project mise.toml and never publishes a global one.',
  },
};

/** A doctor check with its own words, or null for a tool version. */
function ownCheck(id: string, status: Check['status']): Check | null {
  if (!Object.hasOwn(OWN, id)) return null;
  const own = OWN[id]!;
  const ok = status === 'pass';
  return {
    id: `tool:${id}`,
    status,
    summary: ok ? own.pass : own.fail,
    ...(!ok ? { remedy: { action: own.action } } : {}),
  };
}

function toolCheck(value: unknown): Check | null {
  if (
    !record(value) ||
    typeof value['id'] !== 'string' ||
    !/^[a-zA-Z0-9@:/._-]{1,75}$/.test(value['id']) ||
    !['pass', 'fail', 'warn', 'skip'].includes(String(value['status']))
  )
    return null;
  const own = ownCheck(value['id'], value['status'] as Check['status']);
  if (own) return own;
  const ok = value['status'] === 'pass';
  const version =
    typeof value['detail'] === 'string' &&
    /^v?\d{1,6}(?:\.\d{1,6}){1,3}$/.test(value['detail'])
      ? ` ${value['detail']}`
      : '';
  return {
    id: `tool:${value['id'].toLowerCase().replace(/[^a-z0-9:._-]/g, '_')}`,
    status: value['status'] as Check['status'],
    summary: ok
      ? `Expected tool version or runtime check succeeded${version}.`
      : 'Expected tool version, runtime or authentication check did not pass.',
    ...(!ok
      ? {
          remedy: {
            action:
              'Review bootstrap/doctor.ts --json --docker locally. Use shared mise/workstation setup to reconcile this computer.',
          },
        }
      : {}),
  };
}

function doctorArguments(root: string, worker?: ToolSelection): string[] {
  return [
    'bun',
    join(root, 'bootstrap/doctor.ts'),
    '--json',
    '--docker',
    ...(worker ? ['--worker', ...selectionArguments(worker)] : []),
  ];
}
