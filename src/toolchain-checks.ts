import { join } from 'node:path';
import { record } from './config';
import type { Check, Runner } from './types';

export async function toolchainChecks(
  root: string,
  run: Runner,
  worker?: boolean
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

function toolCheck(value: unknown): Check | null {
  if (
    !record(value) ||
    typeof value['id'] !== 'string' ||
    !/^[a-zA-Z0-9@:/._-]{1,75}$/.test(value['id']) ||
    !['pass', 'fail', 'warn', 'skip'].includes(String(value['status']))
  )
    return null;
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

function doctorArguments(root: string, worker?: boolean): string[] {
  return [
    'bun',
    join(root, 'bootstrap/doctor.ts'),
    '--json',
    '--docker',
    ...(worker ? ['--worker'] : []),
  ];
}
