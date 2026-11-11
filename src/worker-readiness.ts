import { workerCapacity } from './worker-capacity';
import { userInfo, hostname } from 'node:os';
import { hostId } from './topology';
import { configPath } from './fleet-config';
import type { Check, Runner } from './types';
import { workerHostChecks } from './worker-host-checks';
import { workerAccessChecks } from './worker-access-checks';
import { record } from './config';

export async function workerReadiness(
  run: Runner,
  nodeId = hostId(hostname()),
  root = process.cwd()
): Promise<Check[]> {
  const host = await workerHostChecks(userInfo().username, run);
  const access = await workerAccessChecks(run);
  const revision = await run(['git', 'rev-parse', 'HEAD']);
  const singleton = await run(
    [
      'python3',
      '-B',
      'cliproxy/scripts/fleet_sync.py',
      '--definition',
      configPath(),
      '--node',
      nodeId,
      '--revision',
      revision.stdout.trim(),
    ],
    { timeoutMs: 180_000 }
  );
  let proxy: Check = {
    id: 'worker:proxy-singleton',
    status: 'fail',
    summary:
      'Singleton gateway ownership or client-only role could not be verified.',
  };
  try {
    const value: unknown = JSON.parse(singleton.stdout);
    if (
      singleton.ok &&
      record(value) &&
      Array.isArray(value['phases']) &&
      value['phases'].length &&
      value['phases'].every(
        (item) => record(item) && item['status'] === 'unchanged'
      )
    )
      proxy = {
        ...proxy,
        status: 'pass',
        summary:
          'Declared gateway host/client-only role verified without changing runtime identity.',
      };
  } catch {
    /* Raw proxy output is never exposed. */
  }
  return [
    ...host,
    ...access,
    proxy,
    ...(await workerCapacity(root, nodeId, run)),
  ];
}
