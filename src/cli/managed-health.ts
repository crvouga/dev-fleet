import { verifyT3Linked } from '../t3-linked-check';
import { verifyT3Endpoint } from '../t3-endpoint';
import type { Check, NodeReport, Runner } from '../types';
import { fleet as definition } from '../fleet-config';
import { enrolledRoster } from '../definition';
import type { Tailnet } from '../tailscale';
import type { FleetNode } from '../types';
import {
  PUBLIC_HUB_URL,
  verifyBeszel,
  type BeszelRequest,
} from '../monitoring/beszel';
import { hubAccess } from '../monitoring/hub-access';
import { hubUrl } from '../topology';

export interface DashboardAccess {
  (hub: string): Promise<{ request: BeszelRequest }>;
}

/** The hub always runs on the manager, reached by its MagicDNS name. */
export function dashboardUrl(tailnet: Tailnet): string | null {
  const canonical = definition;
  const visible = tailnet.computers.some(
    (computer) =>
      computer.dns.replace(/\.$/, '') ===
      canonical.manager.network.tailscaleName
  );
  return visible ? hubUrl(canonical) : null;
}

/** Centralized dashboard evidence for every canonical worker: the hub must answer
 * privately, and each node must be registered, connected and reporting fresh
 * samples. A missing manager Vault session is reported, never silently passed.
 */
export async function appendDashboardEvidence(
  reports: NodeReport[],
  tailnet: Tailnet,
  options: { access?: DashboardAccess; fetcher?: typeof fetch } = {}
): Promise<string | null> {
  const hub = dashboardUrl(tailnet);
  const dashboard: NodeReport = { node: 'dashboard', checks: [] };
  reports.push(dashboard);
  if (!hub) {
    dashboard.checks.push(
      fail(
        'beszel:hub',
        'BESZEL_HUB_SELECTION_REQUIRED',
        'The hub runs on the manager, which is not visible in Tailscale. Wake the manager and reconnect it to the tailnet.'
      )
    );
    return null;
  }
  const fetcher = options.fetcher ?? fetch;
  dashboard.checks.push(await hubReachable(hub, fetcher));
  dashboard.checks.push(await publicEndpoint(fetcher));
  await nodeEvidence(reports, dashboard, hub, options.access ?? hubAccess);
  return hub;
}

async function nodeEvidence(
  reports: NodeReport[],
  dashboard: NodeReport,
  hub: string,
  access: DashboardAccess
): Promise<void> {
  const canonical = definition;
  try {
    const { request } = await access(hub);
    for (const machine of canonical.workers) {
      const evidence = await verifyBeszel(hub, machine.id, request);
      const report =
        reports.find(
          (entry) =>
            entry.node === machine.network?.tailscaleName ||
            entry.node === machine.id
        ) ?? dashboard;
      report.checks.push(...evidence.checks);
    }
  } catch (error) {
    dashboard.checks.push({
      id: 'beszel:access',
      status: 'skip',
      summary:
        error instanceof Error && error.message.startsWith('BESZEL_')
          ? error.message
          : 'BESZEL_ACCOUNT_REQUIRED',
      remedy: {
        action:
          'Authenticate this manager to Vault so BESZEL_FLEET_AUTH can be read, then rerun fleet-status --workers. Node registration and metric freshness are unverified until then.',
      },
    });
  }
}

async function hubReachable(
  hub: string,
  fetcher: typeof fetch
): Promise<Check> {
  try {
    const response = await fetcher(`${hub}/api/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok)
      return {
        id: 'beszel:hub',
        status: 'pass',
        summary: `Dashboard answers privately at ${hub}.`,
      };
  } catch {
    /* Connection details are not evidence; fall through. */
  }
  return fail(
    'beszel:hub',
    'BESZEL_HUB_UNREACHABLE',
    `The private dashboard did not answer at ${hub}/api/health. The hub runs on the manager: keep it awake with Docker Desktop running, then run devfleet fleet-sync there.`
  );
}

/** The Cloudflare hostname is convenience access; the private hub stays canonical,
 * so an offline connector warns instead of failing the audit.
 */
async function publicEndpoint(fetcher: typeof fetch): Promise<Check> {
  try {
    const response = await fetcher(`${PUBLIC_HUB_URL}/api/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok)
      return {
        id: 'beszel:public-endpoint',
        status: 'pass',
        summary: `Dashboard answers publicly at ${PUBLIC_HUB_URL}.`,
      };
  } catch {
    /* Connection details are not evidence; fall through. */
  }
  return {
    id: 'beszel:public-endpoint',
    status: 'warn',
    summary: 'BESZEL_PUBLIC_ENDPOINT_OFFLINE',
    remedy: {
      action: `${PUBLIC_HUB_URL} did not answer. Create the Cloudflare tunnel and store its token in the fleet's secrets, then run fleet-sync on the manager so the hub starts its Cloudflare connector. The private dashboard is unaffected.`,
    },
  };
}

function fail(id: string, summary: string, action: string): Check {
  return { id, status: 'fail', summary, remedy: { action } };
}

/** Explicit developer scope; the ordinary health command still audits all peers. */
export function managedHealthScope(
  tailnet: Tailnet,
  roster: FleetNode[],
  includeManager = true
) {
  const canonical = definition;
  const declared = roster.filter((node) =>
    canonical.workers.some((entry) => entry.id === node.id)
  );
  const nodes = declared.length
    ? enrolledRoster(canonical, { version: 1, nodes: declared }).nodes
    : [];
  const computers = tailnet.computers.filter(
    (peer) =>
      (includeManager && peer.self) ||
      canonical.workers.some(
        (node) =>
          peer.dns === node.network?.tailscaleName ||
          peer.dns.split('.')[0] === node.ssh ||
          nodes.some(
            (entry) => entry.id === node.id && entry.tailscaleId === peer.id
          )
      )
  );
  const missing = canonical.workers.filter(
    (node) => !nodes.some((entry) => entry.id === node.id)
  );
  return {
    nodes,
    tailnet: {
      ...tailnet,
      computers,
      checks: [
        ...tailnet.checks,
        ...missing.map((node) => ({
          id: `fleet:enrollment:${node.id}`,
          status: 'fail' as const,
          summary:
            'Canonical developer node lacks a verified SSH/check-out registration.',
          remedy: {
            action: `Enroll ${node.id} with devfleet fleet-node-add, or use interactive fleet-sync enrollment.`,
          },
        })),
      ],
    },
    excluded: tailnet.computers
      .filter((peer) => !computers.includes(peer))
      .map((peer) => peer.dns),
  };
}

export async function appendManagerLinks(
  reports: NodeReport[],
  registered: FleetNode[],
  run: Runner
): Promise<void> {
  for (const node of registered) {
    const machine = definition.workers.find((entry) => entry.id === node.id);
    const report = reports.find(
      (entry) =>
        entry.node === machine?.network?.tailscaleName || entry.node === node.id
    );
    if (!report) continue;
    report.checks.push(...(await verifyT3Endpoint(node, run)));
    report.checks.push(await verifyT3Linked(node, run));
  }
}
