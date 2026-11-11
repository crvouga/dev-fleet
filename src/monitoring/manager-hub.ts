import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { runAnsibleWithReceipt } from '../platform/ansible-receipt';
import { failure, inspectRoute, publicEndpointCheck, tunnelToken } from './hub';
import { publicViewerIdentity, fleetAccount } from './hub-access';
import { ensurePublicViewer, type HubLogin } from './hub-viewer';
import type { FleetDefinition } from '../definition';
import { hostId, hubUrl } from '../topology';
import { publicHubUrl, privateHub } from './beszel';
import type { Check, Runner } from '../types';

/** Bundled CLI of the Tailscale macOS app when no `tailscale` is on PATH. */
export const TAILSCALE_APP_CLI =
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const LOCAL_HUB = 'http://127.0.0.1:8090';

/** Per-user hub paths on the manager. Data stays in the human's home (and its
 * normal backups); it is never copied to a worker.
 */
export function managerHubPaths(home = homedir()): {
  data: string;
  tunnel: string;
} {
  const support = join(home, 'Library', 'Application Support');
  return {
    data: join(support, 'personal-beszel'),
    tunnel: join(support, 'personal-beszel-tunnel'),
  };
}

/** `tailscale` on PATH (Homebrew or the app's installed CLI), else the app
 * bundle's executable; null when neither exists.
 */
export function tailscaleCommand(
  path = process.env['PATH'] ?? '',
  exists: (candidate: string) => boolean = existsSync
): string | null {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'tailscale');
    if (exists(candidate)) return candidate;
  }
  return exists(TAILSCALE_APP_CLI) ? TAILSCALE_APP_CLI : null;
}

export interface ManagerHubOptions {
  home?: string;
  tailscale?: string | null;
  /** Fleet login for a fresh hub; defaults to the manager's Vault session. */
  account?: () => Promise<HubLogin | null>;
  /** Receipt directory for skipping an unchanged hub apply. */
  receipts?: string;
  /** Ensures the read-only AUTO_LOGIN user; defaults to the loopback hub API. */
  viewer?: (login: HubLogin | null) => Promise<Check>;
}

/** Converges the singleton Beszel hub locally on the manager: pinned Compose
 * under Docker Desktop, the connector token from the manager's own Vault
 * session (private variables file, never argv or output), a private Tailscale
 * Serve route, then independent health checks locally and over the tailnet.
 */
export async function convergeManagerHub(
  root: string,
  definition: FleetDefinition,
  run: Runner,
  options: ManagerHubOptions = {}
): Promise<Check[]> {
  const hub = privateHub(hubUrl(definition));
  const refused = await preconditions(definition, run);
  if (refused) return refused;
  const paths = managerHubPaths(options.home);
  const tunnel = await tunnelToken(run);
  const account = await (options.account ?? fleetAccount)();
  const monitoring = resolve(root, 'ansible/monitoring');
  const result = await runAnsibleWithReceipt(
    run,
    'hub-darwin.yml',
    {
      cwd: monitoring,
      input: JSON.stringify(hubVariables(hub, paths, tunnel, account)),
      timeoutMs: 300_000,
    },
    {
      name: 'beszel-hub',
      sources: [monitoring],
      // Health is verified independently below on every run.
      verify: async () =>
        (
          await run([
            'curl',
            '-fsS',
            '--max-time',
            '5',
            '-o',
            '/dev/null',
            `${LOCAL_HUB}/api/health`,
          ])
        ).ok,
      ...(options.receipts ? { directory: options.receipts } : {}),
    }
  );
  if (!result.ok)
    return failure(
      'BESZEL_HUB_INSTALLATION_INCOMPLETE',
      'Inspect Docker Desktop, the Compose image, file sharing for ~/Library/Application Support and disk space. Existing data is never deleted.'
    );
  const route = await servePrivateRoute(
    hub,
    run,
    options.tailscale === undefined ? tailscaleCommand() : options.tailscale
  );
  if (route) return route;
  const health = await verifyHealth(hub, run);
  if (health) return health;
  return [
    {
      id: 'beszel:hub',
      status: 'pass',
      summary: `Pinned hub on the manager is healthy locally and at ${hub}; authentication and agent metrics are separate checks.`,
    },
    publicEndpointCheck(tunnel !== null),
    await ensureViewer(options, account),
  ];
}

function hubVariables(
  hub: string,
  paths: { data: string; tunnel: string },
  tunnel: string | null,
  account: HubLogin | null
): Record<string, string> {
  return {
    beszel_hub_url: hub,
    beszel_public_url: publicHubUrl(),
    beszel_auto_login: publicViewerIdentity(),
    beszel_data_dir: paths.data,
    beszel_tunnel_dir: paths.tunnel,
    ...(tunnel ? { beszel_tunnel_token: tunnel } : {}),
    ...(account
      ? {
          beszel_fleet_identity: account.identity,
          beszel_fleet_password: account.password,
        }
      : {}),
  };
}

function ensureViewer(
  options: ManagerHubOptions,
  account: HubLogin | null
): Promise<Check> {
  return (options.viewer ?? ensurePublicViewer)(account);
}

/** Runs only on the manager, and only with Docker Desktop's engine up. */
async function preconditions(
  definition: FleetDefinition,
  run: Runner
): Promise<Check[] | null> {
  const local = await run(['/usr/sbin/scutil', '--get', 'LocalHostName']);
  if (!local.ok || hostId(local.stdout.trim()) !== definition.manager.id)
    return failure(
      'BESZEL_NOT_MANAGER',
      `The Beszel hub runs only on the manager (${definition.manager.id}). Run fleet-sync from the manager; workers only run the agent.`
    );
  const docker = await run(
    ['docker', 'info', '--format', '{{.ServerVersion}}'],
    { timeoutMs: 20_000 }
  );
  if (!docker.ok || docker.stdout.trim() === '')
    return failure(
      'BESZEL_DOCKER_DESKTOP_REQUIRED',
      'Start Docker Desktop on the manager (and enable "Start Docker Desktop when you sign in"), then rerun fleet-sync. Existing hub data is never deleted.'
    );
  return null;
}

async function servePrivateRoute(
  hub: string,
  run: Runner,
  cli: string | null
): Promise<Check[] | null> {
  if (!cli)
    return failure(
      'BESZEL_TAILSCALE_REQUIRED',
      `Install and sign in to Tailscale on the manager (Homebrew CLI or ${TAILSCALE_APP_CLI}).`
    );
  const status = await run([cli, 'serve', 'status', '--json']);
  if (!status.ok)
    return failure(
      'BESZEL_PRIVATE_ROUTE_UNVERIFIED',
      'Inspect Tailscale Serve permission and existing private routes before retry.'
    );
  const route = inspectRoute(status.stdout, hub);
  if (Array.isArray(route)) return route;
  if (!route) {
    const serve = [cli, 'serve', '--bg', '--https=8443', LOCAL_HUB] as const;
    const applied =
      (await run([...serve], { timeoutMs: 20_000 })).ok ||
      (await run(['sudo', '-n', ...serve], { timeoutMs: 20_000 })).ok;
    if (!applied)
      return failure(
        'BESZEL_PRIVATE_ROUTE_REQUIRED',
        'Allow Tailscale Serve (HTTPS certificates) for this tailnet and approve it in the Tailscale app if asked; no tailnet policy or public ingress is changed.'
      );
  }
  const verified = await run([cli, 'serve', 'status', '--json']);
  if (!verified.ok || inspectRoute(verified.stdout, hub) !== true)
    return failure(
      'BESZEL_PRIVATE_ROUTE_UNVERIFIED',
      'The requested route was not independently observed after application. Inspect Serve permissions and configuration; installer success is insufficient.'
    );
  return null;
}

async function verifyHealth(hub: string, run: Runner): Promise<Check[] | null> {
  const probe = (url: string) =>
    run(['curl', '-fsS', '--max-time', '10', '-o', '/dev/null', url], {
      timeoutMs: 15_000,
    });
  if (!(await probe(`${LOCAL_HUB}/api/health`)).ok)
    return failure(
      'BESZEL_HUB_UNHEALTHY',
      'The hub container did not answer /api/health locally. Inspect Docker Desktop and the personal-beszel Compose project; preserve its data.'
    );
  if (!(await probe(`${hub}/api/health`)).ok)
    return failure(
      'BESZEL_HUB_UNREACHABLE',
      `The hub is healthy locally but not at ${hub}. Inspect Tailscale on the manager and its Serve route.`
    );
  return null;
}
