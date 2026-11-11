import { mkdir, rm } from 'node:fs/promises';
import { loadRoster } from './roster';
import { enrolledRoster } from '../definition';
import { FleetUsageError } from '../errors';
import { dirname } from 'node:path';
import { fleet as definition } from '../fleet-config';
import { discoverTailnet } from '../tailscale';
import { matchComputers } from '../tailnet-matching';
import { sshArgs, sshFailure } from '../ssh';
import { ensurePrivateRoot } from '../machine/state';
import type { FleetNode, Runner } from '../types';
import { STATE_ROSTER, readRosterText, writeRosterText } from '../state/roster';

/** Interactive enrollment/resume only. Existing paths and explicit identities
 * are preserved. Tailnet candidates never enter the declared membership.
 */
export async function enrollManager(path: string, run: Runner): Promise<void> {
  const canonical = definition;
  const original = await existingEnrollment(path);
  const saved =
    original === null
      ? []
      : enrolledRoster(canonical, await loadRoster(path)).nodes;
  const nodes: FleetNode[] = canonical.workers.map((node) => ({
    id: node.id,
    ssh: node.ssh,
    workspace: '/',
    required: ['t3', 'toolchain', 'workstation'],
  }));
  const pending = nodes.filter(
    (node) => !saved.find((entry) => entry.id === node.id)?.tailscaleId
  );
  if (!pending.length) return;
  const tailnet = await discoverTailnet(run);
  const matches = await matchComputers(nodes, tailnet.computers, run);
  const enrolled: FleetNode[] = [];
  for (const node of pending) {
    const peers = tailnet.computers.filter((peer) =>
      matches.get(peer.id)?.some((candidate) => candidate.id === node.id)
    );
    if (
      ambiguous(
        peers.map((peer) => peer.id),
        matches
      )
    )
      continue;
    const connection = await inspectConnection(node, peers[0]?.id, run);
    if (connection) enrolled.push(connection);
  }
  const merged = mergeEnrollment(saved, enrolled);
  if (JSON.stringify(merged) === JSON.stringify(saved)) return;
  // Only canonical nodes reached over host-key-verified SSH get here, so
  // enrollment needs no extra confirmation; the list is still shown.
  process.stderr.write(
    `Enrolling verified SSH connections for canonical targets:\n${enrolled.map((node) => `  ${node.id} → ${node.ssh}; device ${enrollmentIdentity(node)}`).join('\n')}\nMissing targets remain visible and are never replaced by discovered peers.\n`
  );
  await persistEnrollment(path, original, merged);
}

async function inspectConnection(
  node: FleetNode,
  peerId: string | undefined,
  run: Runner
): Promise<FleetNode | null> {
  const home = await run([...sshArgs(node), 'printf "%s" "$HOME"'], {
    timeoutMs: 20_000,
  });
  if (!home.ok) {
    const check = sshFailure(home);
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
