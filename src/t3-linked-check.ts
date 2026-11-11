import { sshArgs } from './ssh';
import { record } from './config';
import type { Check, FleetNode, Runner } from './types';

/** Correlate a live SSH-verified server identity with the native manager's authenticated link. */
export async function verifyT3Linked(
  node: FleetNode,
  run: Runner,
  options: {
    now?: () => number;
    /** After this sync restarted the node's T3, give its link time to reconnect. */
    reconnectMs?: number;
    pause?: () => Promise<void>;
  } = {}
): Promise<Check> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.reconnectMs ?? 0);
  let check = await linkedOnce(node, run, now());
  while (check.status === 'fail' && now() < deadline) {
    await (
      options.pause ?? (() => new Promise((done) => setTimeout(done, 10_000)))
    )();
    check = await linkedOnce(node, run, now());
  }
  return check.status === 'fail' ? explained(node, run, check) : check;
}

/** A worker enrolled with one T3 environment that now runs another lost
 * its identity (a reset data directory, a reinstall): the old link cannot
 * reach it, and a new pairing is the remedy, not a reconnect.
 */
async function explained(
  node: FleetNode,
  run: Runner,
  check: Check
): Promise<Check> {
  if (!node.t3EnvironmentId) return check;
  const observed = await observedIdentity(node, run).catch(() => undefined);
  if (!observed || observed === node.t3EnvironmentId) return check;
  return {
    ...check,
    summary: 'T3_ENVIRONMENT_IDENTITY_CHANGED',
    remedy: {
      action:
        'This worker now runs a different T3 environment than the one enrolled in the roster, so the manager’s link cannot reach it. Find out why its T3 data was replaced before anything else; then pair the new environment through T3 Connections and enroll it again. Fleet never copies or rewrites a T3 identity.',
    },
  };
}

async function linkedOnce(
  node: FleetNode,
  run: Runner,
  now: number
): Promise<Check> {
  const unavailable: Check = {
    id: 't3:paired-access',
    status: 'fail',
    summary: 'MANAGER_T3_LINK_UNVERIFIED',
    remedy: {
      action:
        'Link this exact worker environment to the manager using T3 Connections once. Existing pairing identities are preserved; passwords and pairing tokens are never copied by Fleet.',
    },
  };
  try {
    const identity =
      node.t3EnvironmentId ?? (await observedIdentity(node, run));
    if (!identity) return unavailable;
    const result = await run(['t3', 'environment', 'list', '--json'], {
      timeoutMs: 30_000,
    });
    const links: unknown = JSON.parse(result.stdout);
    if (!result.ok || !Array.isArray(links)) return unavailable;
    return linkedEvidence(links, identity, unavailable, now);
  } catch {
    return unavailable;
  }
}

function linkedEvidence(
  links: unknown[],
  environmentId: string,
  unavailable: Check,
  now: number
): Check {
  const link = links.find(
    (value) => record(value) && value['environmentId'] === environmentId
  );
  if (
    !record(link) ||
    link['status'] !== 'reachable' ||
    typeof link['expiresAt'] !== 'string'
  )
    return unavailable;
  const expires = Date.parse(link['expiresAt']);
  if (!Number.isFinite(expires) || expires <= now) return unavailable;
  return {
    ...unavailable,
    status: expires - now < 7 * 86400000 ? 'warn' : 'pass',
    summary:
      expires - now < 7 * 86400000
        ? 'Exact worker link is reachable but its manager authorization expires within seven days.'
        : 'Native T3 authenticated link reaches the exact enrolled worker environment. This checks connected access, not a model task.',
  };
}

async function observedIdentity(
  node: FleetNode,
  run: Runner
): Promise<string | undefined> {
  const server = await run(
    [
      ...sshArgs(node),
      'curl --fail --silent --max-time 5 http://127.0.0.1:3773/.well-known/t3/environment',
    ],
    { timeoutMs: 15_000 }
  );
  const identity: unknown = JSON.parse(server.stdout);
  return server.ok &&
    record(identity) &&
    typeof identity['environmentId'] === 'string'
    ? identity['environmentId']
    : undefined;
}
