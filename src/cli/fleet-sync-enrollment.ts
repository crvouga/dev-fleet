import { mkdir, rm } from 'node:fs/promises';
import { loadRoster } from './roster';
import { enrolledRoster, sshTarget, type FleetDefinition } from '../definition';
import { FleetUsageError } from '../errors';
import { dirname } from 'node:path';
import { fleet } from '../fleet-config';
import { discoverTailnet } from '../tailscale';
import { matchComputers } from '../tailnet-matching';
import { sshArgs, sshFailure } from '../ssh';
import { ensurePrivateRoot } from '../machine/state';
import { createWorkerAccount } from '../worker-account';
import { packagePlaybook, type PackagePlaybook } from '../platform/ansible';
import type { Check, FleetNode, Runner } from '../types';
import { STATE_ROSTER, readRosterText, writeRosterText } from '../state/roster';
import { readParked } from '../state/workers';

/** What an enrollment did: the workers whose roster entry it added or
 * completed, and the checks that say why another one was not enrolled (or
 * what was done to reach it).
 */
export interface EnrollmentResult {
  enrolled: string[];
  checks: { node: string; check: Check }[];
}

export interface EnrollmentOptions {
  /** A person is at the terminal and sees the list of what is enrolled. */
  interactive: boolean;
  /** A worker not on the tailnet yet joins it during this run: the fleet
   * declares a tailnet control plane that issues single-use keys.
   */
  joinable?: boolean;
  definition?: FleetDefinition;
  /** Applies a playbook of the package from the manager. */
  playbook?: PackagePlaybook;
  /** When each parked worker was parked; default the fleet state's. */
  parked?: Record<string, string>;
}

/** Enrolls declared workers, and resumes earlier enrollments. Existing paths
 * and explicit identities are preserved. Tailnet candidates never enter the
 * declared membership. An interactive run enrolls what a fresh
 * host-key-verified SSH session reaches. A run without a person enrolls a
 * worker only when every fact is verified: its pinned host key matched (the
 * session is strict), `sudo -n` works, and exactly one tailnet device matches
 * it, or none when this run joins it to the tailnet itself. Anything
 * ambiguous stays out, with the code that says why; nothing prompts.
 */
export async function enrollManager(
  path: string,
  run: Runner,
  options: EnrollmentOptions = { interactive: true }
): Promise<EnrollmentResult> {
  const canonical = options.definition ?? fleet;
  const result: EnrollmentResult = { enrolled: [], checks: [] };
  const original = await existingEnrollment(path);
  const saved =
    original === null
      ? []
      : enrolledRoster(canonical, await loadRoster(path)).nodes;
  const nodes: FleetNode[] = canonical.workers.map((node) => ({
    id: node.id,
    ssh: sshTarget(node),
    workspace: '/',
    required: ['t3', 'toolchain', 'workstation'],
  }));
  // A parked worker is off on purpose: it is enrolled once it is resumed.
  const parked = options.parked ?? readParked();
  const pending = nodes.filter(
    (node) =>
      !parked[node.id] &&
      !saved.find((entry) => entry.id === node.id)?.tailscaleId
  );
  if (!pending.length) return result;
  const tailnet = await discoverTailnet(run);
  const matches = await matchComputers(nodes, tailnet.computers, run);
  const enrolled: FleetNode[] = [];
  for (const node of pending) {
    // A worker already in the roster reports its own state in the run.
    const known = saved.some((entry) => entry.id === node.id);
    const connection = await enrollOne(node, {
      run,
      options,
      peers: tailnet.computers
        .filter((peer) =>
          matches.get(peer.id)?.some((candidate) => candidate.id === node.id)
        )
        .map((peer) => peer.id),
      matches,
      user: canonical.workers.find((worker) => worker.id === node.id)?.network
        ?.user,
      note: (check) => {
        if (!known) result.checks.push({ node: node.id, check });
      },
    });
    if (connection) enrolled.push(connection);
  }
  const merged = mergeEnrollment(saved, enrolled);
  if (JSON.stringify(merged) === JSON.stringify(saved)) return result;
  // Only canonical nodes reached over host-key-verified SSH get here, so
  // enrollment needs no extra confirmation; the list is still shown.
  if (options.interactive)
    process.stderr.write(
      `Enrolling verified SSH connections for canonical targets:\n${enrolled.map((node) => `  ${node.id} → ${node.ssh}; device ${enrollmentIdentity(node)}`).join('\n')}\nMissing targets remain visible and are never replaced by discovered peers.\n`
    );
  await persistEnrollment(path, original, merged);
  result.enrolled = merged
    .filter(
      (node) =>
        JSON.stringify(node) !==
        JSON.stringify(saved.find((entry) => entry.id === node.id))
    )
    .map((node) => node.id);
  return result;
}

/** One worker's connection, when every fact this run needs is verified. */
async function enrollOne(
  node: FleetNode,
  context: {
    run: Runner;
    options: EnrollmentOptions;
    /** The tailnet devices that match this worker. */
    peers: string[];
    matches: Map<string, FleetNode[]>;
    user: string | undefined;
    note: (check: Check) => void;
  }
): Promise<FleetNode | null> {
  const { run, options, peers, note } = context;
  if (ambiguous(peers, context.matches)) {
    if (!options.interactive) note(IDENTITY_CONFLICT);
    return null;
  }
  if (!options.interactive && !peers.length && !options.joinable) {
    note(NOT_ON_TAILNET);
    return null;
  }
  const connection = await inspectConnection(node, peers[0], {
    run,
    options,
    user: context.user,
    note,
    quiet: !options.interactive,
  });
  if (!connection || options.interactive) return connection;
  const privilege = await passwordlessSudo(connection, run);
  if (privilege) note(privilege);
  return privilege ? null : connection;
}

const IDENTITY_CONFLICT: Check = {
  id: 'tailscale:identity',
  status: 'fail',
  summary: 'TAILSCALE_IDENTITY_CONFLICT',
  remedy: {
    action:
      'More than one tailnet device matches this worker, so it was not enrolled. Remove the stale device from the tailnet, then rerun fleet-sync.',
  },
};

const NOT_ON_TAILNET: Check = {
  id: 'tailscale:enrolled-identity',
  status: 'fail',
  summary: 'TAILSCALE_ENROLLMENT_REQUIRED',
  remedy: {
    action:
      'No tailnet device matches this worker and fleet.json declares no tailnet control plane to join it with, so a run without a person did not enroll it. Declare tailnet with the secret tailnet-admin, join the machine yourself, or run fleet-sync once in a terminal.',
  },
};

/** A run without a person never prompts for sudo: the account has it, or the
 * worker is not enrolled.
 */
async function passwordlessSudo(
  node: FleetNode,
  run: Runner
): Promise<Check | null> {
  const result = await run([...sshArgs(node), 'sudo -n true'], {
    timeoutMs: 15_000,
  });
  if (result.ok) return null;
  if (result.reason !== 'exit' || !/sudo:/i.test(result.stderr))
    return sshFailure(result);
  return {
    id: 'bootstrap:privilege',
    status: 'fail',
    summary: 'SUDO_AUTHORIZATION_REQUIRED',
    remedy: {
      action:
        'The worker account has no passwordless sudo, so a run without a person did not enroll it. Grant it (a fleet-node-seed seed does), or run fleet-sync once in a terminal to authorize it.',
    },
  };
}

/** The account's home over a fresh strict session. A machine whose image
 * lets only root in refuses the declared account: it is created once over
 * the root login, and the session is opened again.
 */
async function inspectConnection(
  node: FleetNode,
  peerId: string | undefined,
  context: {
    run: Runner;
    options: EnrollmentOptions;
    user: string | undefined;
    note: (check: Check) => void;
    quiet: boolean;
  }
): Promise<FleetNode | null> {
  const { run } = context;
  const probe = () =>
    run([...sshArgs(node), 'printf "%s" "$HOME"'], { timeoutMs: 20_000 });
  let home = await probe();
  if (!home.ok && sshFailure(home).id === 'ssh:auth' && context.user) {
    const account = await createWorkerAccount(
      { id: node.id, ssh: node.ssh, login: 'root' },
      context.user,
      context.options.playbook ?? packagePlaybook(run)
    );
    // Only an account that was created is reported here: a root login that
    // is refused as well stays the SSH failure below.
    if (account.status === 'pass') {
      context.note(account);
      home = await probe();
    }
  }
  if (!home.ok) {
    const check = sshFailure(home);
    if (context.quiet) context.note(check);
    else
      process.stderr.write(
        `[${node.id}] ${check.id}: ${check.summary} ${check.remedy?.action ?? ''}\n`
      );
    return null;
  }
  if (!/^\/[^\x00-\x1f\x7f]{1,4000}$/.test(home.stdout)) return null;
  return {
    ...node,
    workspace: `${home.stdout}/.local/share/personal/fleet`,
    ...(peerId ? { tailscaleId: peerId } : { bootstrapViaSsh: true }),
  };
}

function enrollmentIdentity(node: FleetNode): string {
  return (
    node.tailscaleId ??
    'initial trusted SSH bootstrap; native Tailscale login required'
  );
}

function ambiguous(ids: string[], matches: Map<string, FleetNode[]>): boolean {
  return (
    ids.length > 1 || (ids.length === 1 && matches.get(ids[0]!)?.length !== 1)
  );
}
function existingEnrollment(path: string): Promise<string | null> {
  return readRosterText(path);
}
export function mergeEnrollment(
  saved: FleetNode[],
  discovered: FleetNode[]
): FleetNode[] {
  const result = saved.map((node) => ({ ...node }));
  for (const candidate of discovered) {
    const existing = result.find((node) => node.id === candidate.id);
    if (!existing) result.push(candidate);
    else if (!existing.tailscaleId && candidate.tailscaleId) {
      existing.tailscaleId = candidate.tailscaleId;
      delete existing.bootstrapViaSsh;
    }
  }
  return result;
}
async function persistEnrollment(
  path: string,
  original: string | null,
  nodes: FleetNode[]
): Promise<void> {
  const write = async (): Promise<void> => {
    if ((await existingEnrollment(path)) !== original)
      throw new FleetUsageError(
        'Enrollment changed during approval. Inspect it and rerun; no connection was overwritten.'
      );
    await writeRosterText(
      path,
      JSON.stringify({ version: 1, nodes }, null, 2) + '\n'
    );
  };
  // The fleet state serializes its own writers; a roster file needs a lock.
  if (path === STATE_ROSTER) return write();
  await ensurePrivateRoot(dirname(path));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.enroll.lock`;
  await mkdir(lock, { mode: 0o700 });
  try {
    await write();
  } finally {
    await rm(lock, { recursive: true });
  }
}
