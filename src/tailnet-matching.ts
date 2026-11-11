import type { FleetNode, Runner } from './types';
import type { TailnetComputer } from './tailscale';

export function matchesComputer(host: string, peer: TailnetComputer): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return [peer.dns, peer.dns.split('.')[0], ...peer.ips].includes(name);
}

export async function matchComputers(
  nodes: FleetNode[],
  peers: TailnetComputer[],
  run: Runner
): Promise<Map<string, FleetNode[]>> {
  const matches = new Map(peers.map((peer) => [peer.id, [] as FleetNode[]]));
  for (const node of nodes) {
    const resolved = await run(
      [
        'ssh',
        '-G',
        '-o',
        'CanonicalizeHostname=no',
        '-o',
        'PermitLocalCommand=no',
        node.ssh,
      ],
      { timeoutMs: 5_000 }
    );
    const hostname = resolved.ok
      ? /^hostname ([^\r\n]+)$/im.exec(resolved.stdout)?.[1]?.trim()
      : undefined;
    const targets = peers.filter((peer) =>
      matchesComputer(hostname ?? node.ssh, peer)
    );
    for (const peer of targets) matches.get(peer.id)!.push(node);
  }
  return matches;
}
