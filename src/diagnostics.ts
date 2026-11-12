import type { Check } from './types';

export interface Diagnostic {
  node: string;
  phase: string;
  checkId: string;
  status: Check['status'];
  code: string;
  summary: string;
  expected: string;
  observed: string;
  scope: 'manager' | 'node' | 'unverified';
  durationMs: number | null;
  retryable: boolean;
  actionRequired: boolean;
  remedy: { owner: string; action: string };
}
const EXPECTED: Record<string, string> = {
  ssh: 'Fresh noninteractive SSH session with the enrolled host key and designated user.',
  tailscale:
    'The enrolled device identity is connected and reachable through the intended tailnet.',
  ubuntu:
    'Observed Ubuntu configuration matches the reviewed baseline without a distribution upgrade.',
  t3: 'Pinned native T3 service and the specifically named runtime acceptance check pass.',
  provider:
    'The declared gateway model passes authenticated inference, completed streaming and a bounded tool round trip.',
  proxy:
    'One declared gateway owner preserves runtime identities and serves authorized clients.',
  beszel:
    'Pinned monitoring artifacts, canonical registration and fresh authenticated metrics are independently verified.',
  rollout: 'Required prerequisites and canary gates pass before promotion.',
  manager:
    'Manager enrollment, approval and exclusive operation ownership are valid.',
  source:
    'The approved full commit and packaged canonical definition match verified source.',
  configuration:
    'The existing Workstation owner applies and verifies the selected source configuration.',
};

/** Derived only from already-redacted checks. No raw subprocess errors, journal
 * contents, auth payloads or environment fields enter the diagnostic contract.
 */
export function diagnostic(node: string, check: Check): Diagnostic {
  const phase = check.id.split(':')[0]!;
  // A check that does not apply to this machine asks nothing of anyone.
  const failed = check.status !== 'pass' && check.status !== 'not-applicable';
  const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(check.summary)
    ? check.summary
    : `${check.id.replaceAll(/[^a-z0-9]/g, '_').toUpperCase()}_${failed ? 'UNVERIFIED' : 'VERIFIED'}`;
  return {
    node,
    phase,
    checkId: check.id,
    status: check.status,
    code,
    summary: check.summary,
    expected:
      EXPECTED[phase] ??
      'The named required check has independent verification evidence.',
    observed: check.summary,
    scope: scope(check.id),
    durationMs: check.phaseDurationMs ?? null,
    retryable: failed && /OFFLINE|UNREACHABLE|METRICS_STALE|TIMEOUT/.test(code),
    actionRequired: failed,
    remedy: {
      owner: owner(phase),
      action:
        check.remedy?.action ??
        'Inspect this named check in the Fleet runbook; preserve runtime identity and repair persistent configuration in source.',
    },
  };
}
function scope(id: string): Diagnostic['scope'] {
  if (
    /^(t3:manager-(endpoint|origin)|ssh:|manager:|rollout:|source:|tailscale:(reachability|identity|enrolled-identity))/.test(
      id
    )
  )
    return 'manager';
  if (
    /^(provider:|proxy:|configuration:|ubuntu:baseline|t3:(service|policy)|tailscale:configuration)/.test(
      id
    )
  )
    return 'node';
  if (/^beszel:(version|registration|connection|freshness|api)/.test(id))
    return 'manager';
  return 'unverified';
}
function owner(phase: string): string {
  if (phase === 'proxy') return 'cliproxy';
  return 'dev-fleet';
}
