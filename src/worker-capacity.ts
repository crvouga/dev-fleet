import { join } from 'node:path';
import { clockCheck } from './clock';
import { healthChecks, parseProbe } from './machine-health';
import type { Check, Runner } from './types';
import policy from '../ansible/ubuntu/policy.json';
import { supportedSessions } from './worker-sizing';

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
    ...(sample.memTotalMb === undefined
      ? []
      : [sessionsCheck(sample.memTotalMb, sample.agentSessions)]),
    clockCheck(
      'worker:clock',
      sample,
      reference === undefined || sample.epoch === undefined
        ? undefined
        : sample.epoch - reference
    ),
  ];
}

const SESSIONS_EXHAUSTED = 'AGENT_SESSION_CAPACITY_EXHAUSTED';

/** How many agent sessions this worker's memory policy supports, and how
 * many run. The size of a session is an estimate (`sizing.agentSessionMiB`),
 * so more sessions than that only warns.
 */
export function sessionsCheck(memoryMiB: number, running?: number): Check {
  const supported = supportedSessions(memoryMiB);
  const each = policy.sizing.agentSessionMiB;
  const now = running === undefined ? 'an unknown number' : String(running);
  const over = running !== undefined && running > supported;
  return {
    id: 'worker:agent-sessions',
    status: over ? 'warn' : 'pass',
    summary: `${over ? `${SESSIONS_EXHAUSTED}: ` : ''}${now} agent sessions running; the memory policy supports ${supported} at once on ${memoryMiB} MiB (an estimated ${each} MiB each).`,
    ...(over
      ? {
          remedy: {
            action:
              'More agent sessions run than the memory policy supports: each is still capped, so the largest may be stopped under pressure. Finish some, or move work to a worker with more memory.',
          },
        }
      : {}),
  };
}
