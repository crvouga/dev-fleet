import type { Check, Runner } from '../types';

/** Where installing the agent writes: the pinned build and its state. */
export const AGENT_PATHS = ['/usr/local/lib', '/var/lib'] as const;
/** Room for the archive, the extracted build and the agent's state. */
export const AGENT_FREE_KIB = 256 * 1024;

/** Measures, before anything is installed, that each path the agent writes
 * to has room. A full disk is named as such instead of surfacing later as an
 * incomplete installation.
 */
export async function agentDisk(run: Runner): Promise<Check> {
  const result = await run(['df', '-Pk', ...AGENT_PATHS], {
    timeoutMs: 10_000,
  });
  const free = result.ok ? available(result.stdout) : null;
  if (!free || free.length !== AGENT_PATHS.length)
    return {
      id: 'beszel:disk',
      status: 'fail',
      summary: 'BESZEL_DISK_UNVERIFIED',
      remedy: {
        action: `Free space under ${AGENT_PATHS.join(' and ')} could not be measured. Check that df works for the fleet user, then rerun fleet-sync. Nothing was installed.`,
      },
    };
  const least = Math.min(...free);
  if (least < AGENT_FREE_KIB)
    return {
      id: 'beszel:disk',
      status: 'fail',
      summary: 'BESZEL_DISK_FULL',
      remedy: {
        action: `The monitoring agent needs ${AGENT_FREE_KIB / 1024} MiB free under each of ${AGENT_PATHS.join(' and ')}; the fullest has ${Math.floor(least / 1024)} MiB. Free space on the worker, then rerun fleet-sync. Nothing was installed and the running agent was left as it was.`,
      },
    };
  return {
    id: 'beszel:disk',
    status: 'pass',
    summary: `At least ${Math.floor(least / 1024)} MiB free where the agent is installed.`,
  };
}

/** The "Available" column of POSIX df output, one value per path. */
function available(output: string): number[] | null {
  const rows = output.trim().split('\n').slice(1);
  const values = rows.map((row) => Number(row.trim().split(/\s+/)[3]));
  return values.length && values.every(Number.isSafeInteger) ? values : null;
}

/** What the pinned agent (Beszel 0.21.1) logs about its connection to the
 * hub, from its source:
 * - `agent/connection_manager.go` logs "WebSocket connected" once the hub
 *   proved its key;
 * - the hub answers an unknown token with 401 (`internal/hub/agent_connect.go`),
 *   which the WebSocket library reports as "unexpected status code: 401";
 * - a hub whose key is not the one the agent was given fails
 *   `verifySignature`: "invalid signature - check KEY value";
 * - a hub that is down behind its private route answers 502, 503 or 504.
 * Only these fixed texts are matched; nothing of the log is reported.
 */
const OUTCOMES: { pattern: RegExp; check: Omit<Check, 'id'> }[] = [
  {
    pattern: /WebSocket connected/,
    check: {
      status: 'pass',
      summary: 'The agent is connected to the hub, which proved its key.',
    },
  },
  {
    pattern: /unexpected status code: 401\b/,
    check: {
      status: 'fail',
      summary: 'BESZEL_AGENT_TOKEN_REJECTED',
      remedy: {
        action:
          "The hub refused this worker's agent token. Rerun fleet-sync from the manager so the worker's enrollment is resumed and its token delivered again. Never register a second record for the worker.",
      },
    },
  },
  {
    pattern: /invalid signature - check KEY value/,
    check: {
      status: 'fail',
      summary: 'BESZEL_AGENT_KEY_REJECTED',
      remedy: {
        action:
          "The hub the agent reached did not prove the key it was given. Make sure the worker's agent points at the manager's hub, then rerun fleet-sync from the manager so the hub's key is delivered again.",
      },
    },
  },
  {
    pattern: /unexpected status code: 50[234]\b/,
    check: {
      status: 'warn',
      summary: 'BESZEL_HUB_UNAVAILABLE_TO_AGENT',
      remedy: {
        action:
          'The private route answered but the hub behind it did not. Keep the manager awake with Docker Desktop running and rerun fleet-sync there; the agent reconnects by itself.',
      },
    },
  },
];

/** The agent's newest connection outcome, read from its own log. The log
 * holds host names, so only the outcome is reported.
 */
export async function agentConnection(run: Runner): Promise<Check> {
  const result = await run(
    [
      'sudo',
      '-n',
      'journalctl',
      '--unit=beszel-agent.service',
      '--output=cat',
      '--no-pager',
      '--lines=200',
    ],
    { timeoutMs: 10_000 }
  );
  if (!result.ok)
    return {
      id: 'beszel:hub-connection',
      status: 'skip',
      summary: 'BESZEL_AGENT_LOG_UNAVAILABLE',
      remedy: {
        action:
          "The agent's log could not be read, so how the hub answered it is unknown. The hub's own evidence in fleet-status --workers still applies.",
      },
    };
  return { id: 'beszel:hub-connection', ...newestOutcome(result.stdout) };
}

function newestOutcome(log: string): Omit<Check, 'id'> {
  const lines = log.split('\n').reverse();
  for (const line of lines)
    for (const outcome of OUTCOMES)
      if (outcome.pattern.test(line)) return outcome.check;
  return {
    status: 'skip',
    summary: 'BESZEL_AGENT_CONNECTION_PENDING',
    remedy: {
      action:
        'The agent has not reached the hub yet. The next fleet-sync, or fleet-status --workers, reports whether it did.',
    },
  };
}
