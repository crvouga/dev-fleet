import { compareFingerprints } from './fingerprint';
import { probe } from './probe';
import { inspectRemote } from './transport';
import { mapBounded } from './report';
import { matchComputers } from './tailnet-matching';
import type { Tailnet, TailnetComputer } from './tailscale';
import type {
  Capability,
  Fingerprint,
  Check,
  FleetNode,
  NodeReport,
  Runner,
  Snapshot,
} from './types';

export const HEALTH_CAPABILITIES: Capability[] = [
  't3',
  'toolchain',
  'workstation',
];
export interface TailnetHealthOptions {
  includeManagerReport?: boolean;
  reference?: Snapshot | undefined;
  root: string;
  timeoutMs: number;
  source: () => Promise<string>;
}

export async function tailnetHealth(
  tailnet: Tailnet,
  nodes: FleetNode[],
  options: TailnetHealthOptions,
  run: Runner
): Promise<NodeReport[]> {
  const matches = await matchComputers(nodes, tailnet.computers, run);
  const self = tailnet.computers.find((peer) => peer.self);
  const candidates = self ? (matches.get(self.id) ?? []) : [];
  const required = uniqueMapping(candidates, matches)
    ? candidates[0]!.required
    : HEALTH_CAPABILITIES;
  const manager =
    options.reference ??
    (await probe(
      options.root,
      options.includeManagerReport === false && !self ? [] : required,
      run
    ));
  let source: Promise<string> | undefined;
  const reports = await mapBounded(tailnet.computers, async (peer) => {
    const checks = await connectivity(peer, run);
    if (peer.self)
      return {
        node: peer.dns,
        snapshot: manager,
        checks: [...checks, ...manager.checks],
      };
    const candidates = matches.get(peer.id)!;
    if (!uniqueMapping(candidates, matches))
      return missingMapping(peer, checks, candidates.length);
    if (!peer.online) return { node: peer.dns, checks };
    const node = candidates[0]!;
    const report = await inspectComputer(
      node,
      {
        action: 'probe',
        expected: manager.fingerprint,
        source: (source ??= Promise.resolve().then(options.source)),
        timeoutMs: options.timeoutMs,
      },
      run
    );
    return combine(peer, checks, report, manager);
  });
  const absent = nodes.filter(
    (node) => ![...matches.values()].some((matched) => matched.includes(node))
  );
  return [
    { node: 'tailscale', checks: tailnet.checks },
    ...(options.includeManagerReport !== false &&
    !tailnet.computers.some((peer) => peer.self)
      ? [
          {
            node: 'manager',
            snapshot: manager,
            checks: manager.checks,
          },
        ]
      : []),
    ...reports,
    ...absent.map(absentNode),
  ];
}

export function uniqueMapping(
  candidates: FleetNode[],
  matches: Map<string, FleetNode[]>
): boolean {
  return (
    candidates.length === 1 &&
    [...matches.values()].filter((nodes) => nodes.includes(candidates[0]!))
      .length === 1
  );
}

async function inspectComputer(
  node: FleetNode,
  options: {
    action: 'probe';
    source: Promise<string>;
    timeoutMs: number;
    expected?: Fingerprint;
  },
  run: Runner
): Promise<NodeReport> {
  try {
    return await inspectRemote(
      node,
      { ...options, source: await options.source },
      run
    );
  } catch {
    return {
      node: node.id,
      checks: [
        {
          id: 'fleet:probe',
          status: 'fail',
          summary:
            'The current remote probe could not be prepared or completed; this computer remains unverified.',
          remedy: {
            action:
              'Reinstall the validated Personal CLI package and retry. No raw exception or remote output is retained.',
          },
        },
      ],
    };
  }
}

async function connectivity(
  peer: TailnetComputer,
  run: Runner
): Promise<Check[]> {
  const online: Check = {
    id: 'tailscale:online',
    status: peer.online ? 'pass' : 'fail',
    summary: peer.online
      ? 'Computer is online in Tailscale status.'
      : 'Computer is offline or Tailscale cannot confirm its online state.',
  };
  if (peer.self || !peer.online) return [online];
  const ping = await run(
    ['tailscale', 'ping', '--c=1', '--timeout=5s', peer.ips[0]!],
    { timeoutMs: 8_000 }
  );
  return [
    online,
    {
      id: 'tailscale:reachability',
      status: ping.ok ? 'pass' : 'fail',
      summary: ping.ok
        ? 'Tailscale peer answered a bounded reachability probe.'
        : 'Tailscale peer did not answer; online inventory is not proof of connectivity.',
    },
  ];
}

function missingMapping(
  peer: TailnetComputer,
  checks: Check[],
  count: number
): NodeReport {
  return {
    node: peer.dns,
    checks: [
      ...checks,
      {
        id: 'fleet:registration',
        status: 'fail',
        summary: count
          ? 'Roster mapping is ambiguous between entries or computers; no SSH probe was run.'
          : 'Computer is not registered with a verified SSH alias and checkout path; dependencies and authentication are unverified.',
        remedy: {
          action:
            'Run fleet-node-add with its existing SSH alias and actual checkout path, then rerun fleet-status --tailnet.',
        },
      },
    ],
  };
}

function combine(
  peer: TailnetComputer,
  checks: Check[],
  report: NodeReport,
  reference: Snapshot
): NodeReport {
  return {
    ...report,
    node: peer.dns,
    checks: [
      ...checks,
      ...report.checks,
      ...(report.snapshot
        ? compareFingerprints(
            reference.fingerprint,
            report.snapshot.fingerprint
          )
        : []),
    ],
  };
}

function absentNode(node: FleetNode): NodeReport {
  return {
    node: node.id,
    checks: [
      {
        id: 'tailscale:membership',
        status: 'fail',
        summary:
          'Registered node is absent from visible Tailscale inventory. It was not silently omitted.',
        remedy: {
          action:
            'Check the node account, tailnet visibility, and the registered SSH alias.',
        },
      },
    ],
  };
}
