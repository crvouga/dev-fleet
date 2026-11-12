import { join } from 'node:path';
import { clockCheck } from './clock';
import { healthChecks, parseProbe } from './machine-health';
import type { Check, Runner } from './types';

export async function workerCapacity(
  root: string,
  node: string,
  run: Runner,
  /** The manager's clock in seconds since the epoch, when it sent one. */
  reference?: number
): Promise<Check[]> {
  const result = await run(['sh', join(root, 'ansible/net/remote-probe.sh')], {
    timeoutMs: 10_000,
  });
  const sample = parseProbe(result.stdout);
  if (
    !result.ok ||
    sample.ncpu === undefined ||
    sample.load === undefined ||
    sample.memFreePct === undefined ||
    sample.diskMb === undefined
  )
    return [
      {
        id: 'worker:capacity',
        status: 'fail',
        summary: 'Required CPU, memory and disk evidence is unavailable.',
      },
    ];
  return [
    ...healthChecks(sample, node).map((check) => ({
      id: `worker:capacity:${check.id}`,
      status: check.severity,
      summary: check.detail,
      ...(check.fix ? { remedy: { action: check.fix } } : {}),
    })),
    clockCheck(
      'worker:clock',
      sample,
      reference === undefined || sample.epoch === undefined
        ? undefined
        : sample.epoch - reference
    ),
  ];
}
