import { compareFingerprints, fingerprint } from './fingerprint';
import { probe } from './probe';
import { mapBounded } from './report';
import { bundleProbe, inspectRemote } from './transport';
import type { Capability, FleetNode, NodeReport, Runner } from './types';

export interface DoctorOptions {
  root: string;
  timeoutMs: number;
  local: boolean;
  required: Capability[];
  source?: string;
}

export async function doctor(
  nodes: FleetNode[],
  options: DoctorOptions,
  run: Runner
): Promise<NodeReport[]> {
  const local = await probe(options.root, options.required, run);
  const agent = await run(['ssh-add', '-l']);
  const reports: NodeReport[] = [
    {
      node: 'manager',
      snapshot: local,
      checks: [
        ...local.checks,
        {
          id: 'ssh:agent',
          status: agent.ok ? 'pass' : 'warn',
          summary: agent.ok
            ? 'SSH agent exposes at least one identity.'
            : 'No accessible SSH agent identities; explicit IdentityFile keys may still work.',
          ...(!agent.ok
            ? {
                remedy: {
                  action:
                    'Unlock/load the intended key in the manager session. Check SSH_AUTH_SOCK and GUI/editor agent visibility; do not copy private keys.',
                },
              }
            : {}),
        },
      ],
    },
  ];
  if (options.local || nodes.length === 0) return reports;
  const source = options.source ?? (await bundleProbe());
  const reference = await fingerprint(options.root, run);
  const remote = await mapBounded(nodes, async (node) => {
    const report = await inspectRemote(
      node,
      { action: 'probe', source, timeoutMs: options.timeoutMs },
      run
    );
    if (report.snapshot)
      report.checks.push(
        ...compareFingerprints(reference, report.snapshot.fingerprint)
      );
    return report;
  });
  return [...reports, ...remote];
}
