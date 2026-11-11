import type { Check, Status } from '../types';
import { DIVERGED_REMEDY, type Standing } from './sync';

const INIT =
  'Connect a bucket: devfleet fleet-state --init --bucket NAME --endpoint https://HOST (see docs/state.md). Until then a lost manager loses the fleet configuration, the roster and the approved revision.';

const FINDINGS: Record<
  Standing,
  { status: Status; summary: string; action?: string }
> = {
  'in-sync': {
    status: 'pass',
    summary: 'The bucket holds the fleet state this machine works from.',
  },
  'local-only': {
    status: 'warn',
    summary:
      'No bucket is configured: this machine holds the only copy of the fleet state.',
    action: INIT,
  },
  empty: {
    status: 'warn',
    summary: 'Neither this machine nor the bucket holds any fleet state yet.',
    action:
      'Start from the example: devfleet fleet-state --import examples/fleet.json after editing a copy for your machines.',
  },
  unpublished: {
    status: 'warn',
    summary:
      'The bucket holds no fleet state yet; this machine has the only copy.',
    action: 'Upload it: devfleet fleet-state --push.',
  },
  'local-ahead': {
    status: 'warn',
    summary: 'This machine has fleet state the bucket has not received.',
    action: 'Upload it: devfleet fleet-state --push.',
  },
  'bucket-ahead': {
    status: 'warn',
    summary:
      'The bucket holds a newer fleet state than this machine; another manager changed it.',
    action:
      'The next fleet-sync takes it automatically; devfleet fleet-state --restore takes it now.',
  },
  unreachable: {
    status: 'fail',
    summary:
      'The bucket did not answer, so the fleet state could not be compared or uploaded.',
    action:
      'Check the network, the bucket settings and its credentials (bucket.json), then run devfleet fleet-state --push, which also installs the pinned Litestream when it is missing. Details are withheld to protect credentials.',
  },
  diverged: {
    status: 'fail',
    summary: 'This machine and the bucket hold different fleet states.',
    action: DIVERGED_REMEDY,
  },
};

/** Whether the bucket holds this machine's fleet state. `advisory` reports a
 * problem as a warning: for a run that succeeded in everything else.
 */
export function replicaCheck(
  standing: Standing,
  options: { advisory?: boolean } = {}
): Check {
  const finding = FINDINGS[standing];
  return {
    id: 'state:replica',
    status:
      options.advisory && finding.status === 'fail' ? 'warn' : finding.status,
    summary: finding.summary,
    ...(finding.action ? { remedy: { action: finding.action } } : {}),
  };
}
