import { dependencyCheck, fingerprint } from './fingerprint';
import { CAPABILITIES } from './config';
import { authCheck } from './auth-checks';
import type { Capability, Check, Runner, Snapshot } from './types';

export async function probe(
  root: string,
  required: Capability[],
  run: Runner,
  nodeId?: string
): Promise<Snapshot> {
  const current = await fingerprint(root, run);
  const checks: Check[] = [
    {
      id: 'workspace',
      status:
        Object.values(current.files).every(Boolean) && current.head
          ? 'pass'
          : 'fail',
      summary:
        'Checkout revision and shared dependency/toolchain input availability.',
    },
  ];
  const dirty = await run(['git', 'status', '--porcelain'], { cwd: root });
  checks.push({
    id: 'git:clean',
    status: dirty.ok ? (dirty.stdout.trim() ? 'warn' : 'pass') : 'fail',
    summary:
      dirty.ok && !dirty.stdout.trim()
        ? 'Working tree is clean.'
        : 'Working tree is dirty or unreadable; sync --pull will refuse.',
  });
  checks.push(await dependencyCheck(root, current));
  for (const capability of CAPABILITIES) {
    if (required.includes(capability))
      checks.push(...(await authCheck(capability, run, root, nodeId)));
    else
      checks.push({
        id: `auth:${capability}`,
        status: 'skip',
        required: false,
        summary: 'Not required by this node configuration.',
      });
  }
  return {
    version: 1,
    platform: process.platform,
    fingerprint: current,
    checks,
  };
}
