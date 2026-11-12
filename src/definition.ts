import {
  parseWorkerPolicy,
  toolProfiles,
  type WorkerPolicy,
} from './worker-policy';
import type { ToolProfile } from '../bootstrap/worker-tools';
import { readFileSync } from 'node:fs';
import { FleetUsageError } from './errors';
import { parseConfig, record } from './config';
import type { FleetConfig } from './types';
import { parseSecretsConfig, type SecretsConfig } from './secrets';
import { parseLocation, type BucketLocation } from './state/bucket';
import {
  parseIdes,
  parseT3,
  type IdeId,
  type T3Definition,
} from './ide/definition';
import { parseNotify, type NotifyConfig } from './notify';
import { ubuntuRelease } from './platform/ubuntu-release';
import { parseGithubPolicy, type GithubPolicy } from './github/policy';

export interface MachineDefinition {
  id: string;
  ssh: string;
  os: 'linux';
  /** Tool profiles this worker adds to the fleet-wide ones. */
  toolProfiles?: ToolProfile[];
  network?: {
    tailscaleName: string;
    user: string;
    sshPort: number;
    t3Port: number;
  };
}
/** The singleton manager: the human's machine. It runs fleet-sync and hosts
 * every singleton service; it is never converged over SSH. */
export interface ManagerDefinition {
  id: string;
  os: 'macOS';
  network: { tailscaleName: string; user: string };
  neverSleepOnPower: true;
}
export interface FleetDefinition {
  version: 3;
  /** The Git repository machines take dev-fleet's code from. */
  source: { repository: string };
  /** Where this fleet keeps its secrets. */
  secrets: SecretsConfig;
  /** The bucket that holds the fleet state. Its credentials are never part
   * of the configuration: they come from the environment of the command.
   */
  state?: BucketLocation;
  manager: ManagerDefinition;
  /** Stateless, replaceable Linux boxes; clients of the manager's services. */
  workers: MachineDefinition[];
  services: {
    /** Public HTTPS origin of the CLI proxy every node uses. */
    proxy: { endpoint: string; accounts?: AccountPolicy };
    monitoring: {
      hubPort: 8443;
      /** Public dashboard origin. */
      publicUrl: string;
      /** Beszel account the manager enrolls nodes with. */
      managerAccount: string;
      /** Read-only Beszel account visitors are signed in as. */
      viewerAccount: string;
      /** Scheduled off-machine backups fleet-sync sets on the hub. */
      backups?: HubBackups;
    };
  };
  worker?: WorkerPolicy;
  /** The IDEs every machine runs; `["t3"]` when not named (idesOf). */
  ides?: IdeId[];
  /** What every machine's T3 holds beyond its provider instances. */
  t3?: T3Definition;
  /** The Git identity and GitHub credential helper every node, manager
   * included, commits and pushes with.
   */
  git?: GitIdentity;
  /** Where fleet-watch sends notifications; absent, nobody is notified. */
  notify?: NotifyConfig;
  /** An Ubuntu release ansible/ubuntu/policy.json accepts, with exactly the
   * architectures the policy names for it. */
  ubuntu: { release: string; architectures: string[] };
  /** How every node signs in to GitHub; defaults when absent. */
  github?: GithubPolicy;
}
/** How provider accounts are watched and chosen (src/accounts/). */
export interface AccountPolicy {
  /** Fewer usable accounts of a provider than this is a warning; none fails. */
  minimumUsable?: number;
  /** Per provider (`claude`, `codex`, `antigravity`): which account an
   * unpinned request goes to first. Accounts cooling down are skipped.
   */
  selection?: Record<string, AccountSelection>;
}
export interface AccountSelection {
  strategy: 'fill-first' | 'round-robin' | 'least-recently-limited';
  /** Account labels (sign-in emails) first, in this order; the others
   * follow in the order of their routing prefix.
   */
  order?: string[];
}
export interface HubBackups {
  /** Cron expression of the hub's backup schedule. */
  schedule: string;
  /** How many scheduled backups the hub keeps. */
  keep: number;
  /** S3-compatible storage off the manager; its keys are secrets. */
  storage: {
    bucket: string;
    endpoint: string;
    region: string;
    forcePathStyle?: boolean;
  };
}
export interface GitIdentity {
  /** `user.name` of every commit. */
  name: string;
  /** `user.email` of every commit. */
  email: string;
  /** A repository each node must reach through git with its own
   * credentials, proving it can push (`worker:git-push-auth`).
   */
  verifyRepository?: string;
}
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const HOST = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/;
function fail(): never {
  throw new FleetUsageError(
    'Invalid Fleet definition. Check version 3, one macOS manager, unique Linux worker IDs, singleton services and network metadata in fleet.json.'
  );
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function network(value: unknown): NonNullable<MachineDefinition['network']> {
  if (
    !record(value) ||
    !keys(value, ['tailscaleName', 'user', 'sshPort', 't3Port'])
  )
    return fail();
  if (
    typeof value['tailscaleName'] !== 'string' ||
    !HOST.test(value['tailscaleName'])
  )
    return fail();
  if (
    typeof value['user'] !== 'string' ||
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(value['user'])
  )
    return fail();
  for (const port of ['sshPort', 't3Port'])
    if (!validPort(value[port])) return fail();
  return value as NonNullable<MachineDefinition['network']>;
}
function validPort(value: unknown): boolean {
  return (
    Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535
  );
}
function worker(value: unknown): MachineDefinition {
  if (
    !record(value) ||
    !keys(value, ['id', 'ssh', 'os', 'network', 'toolProfiles'])
  )
    return fail();
  if (typeof value['id'] !== 'string' || !ID.test(value['id'])) return fail();
  if (typeof value['ssh'] !== 'string' || !HOST.test(value['ssh']))
    return fail();
  // Workers are the Linux boxes; any other platform is not a worker.
  if (value['os'] !== 'linux') return fail();
  return {
    id: value['id'],
    ssh: value['ssh'],
    os: 'linux',
    ...(value['network'] ? { network: network(value['network']) } : {}),
    ...(value['toolProfiles'] === undefined
      ? {}
      : { toolProfiles: toolProfiles(value['toolProfiles']) ?? fail() }),
  };
}
function manager(value: unknown): ManagerDefinition {
  if (
    !record(value) ||
    !keys(value, ['id', 'os', 'network', 'neverSleepOnPower']) ||
    typeof value['id'] !== 'string' ||
    !ID.test(value['id']) ||
    value['os'] !== 'macOS' ||
    value['neverSleepOnPower'] !== true
  )
    return fail();
  return {
    id: value['id'],
    os: 'macOS',
    network: managerNetwork(value['network']),
    neverSleepOnPower: true,
  };
}
function managerNetwork(value: unknown): ManagerDefinition['network'] {
  if (
    !record(value) ||
    !keys(value, ['tailscaleName', 'user']) ||
    typeof value['tailscaleName'] !== 'string' ||
    !HOST.test(value['tailscaleName']) ||
    typeof value['user'] !== 'string' ||
    !/^[a-z_][a-z0-9_.-]{0,31}$/.test(value['user'])
  )
    return fail();
  return { tailscaleName: value['tailscaleName'], user: value['user'] };
}
export function parseDefinition(value: unknown): FleetDefinition {
  if (
    !record(value) ||
    value['version'] !== 3 ||
    !keys(value, [
      '$schema',
      'version',
      'source',
      'secrets',
      'state',
      'manager',
      'workers',
      'services',
      'ubuntu',
      'worker',
      'ides',
      't3',
      'git',
      'notify',
      'github',
    ])
  )
    return fail();
  if (!Array.isArray(value['workers']) || value['workers'].length > 64)
    return fail();
  const lead = manager(value['manager']);
  const workers = value['workers'].map(worker);
  const ids = [lead.id, ...workers.map((entry) => entry.id)];
  if (new Set(ids).size !== ids.length) return fail();
  return {
    version: 3,
    source: source(value['source']),
    secrets: secrets(value['secrets']),
    ...(value['state'] === undefined ? {} : { state: state(value['state']) }),
    manager: lead,
    workers,
    services: services(value['services']),
    ubuntu: baseline(value['ubuntu']),
    ...optionalSections(value),
  };
}
/** The sections a fleet may leave out, kept only when named: an earlier
 * revision must still read the copy.
 */
function optionalSections(
  value: Record<string, unknown>
): Pick<
  FleetDefinition,
  'worker' | 'ides' | 't3' | 'git' | 'notify' | 'github'
> {
  return {
    ...(value['worker'] === undefined
      ? {}
      : { worker: parseWorkerPolicy(value['worker']) }),
    ...(value['ides'] === undefined ? {} : { ides: parseIdes(value['ides']) }),
    ...(value['t3'] === undefined ? {} : { t3: parseT3(value['t3']) }),
    ...(value['git'] === undefined ? {} : { git: gitIdentity(value['git']) }),
    ...(value['notify'] === undefined
      ? {}
      : { notify: parseNotify(value['notify']) ?? fail() }),
    ...(value['github'] === undefined
      ? {}
      : { github: parseGithubPolicy(value['github']) }),
  };
}
/** Singleton services name no host: they always run on the manager. */
function services(value: unknown): FleetDefinition['services'] {
  if (!record(value) || !keys(value, ['proxy', 'monitoring'])) return fail();
  const { proxy, monitoring } = value;
  if (
    !record(proxy) ||
    !keys(proxy, ['endpoint', 'accounts']) ||
    !origin(proxy['endpoint'])
  )
    return fail();
  return {
    proxy: {
      endpoint: proxy['endpoint'],
      ...(proxy['accounts'] === undefined
        ? {}
        : { accounts: accountPolicy(proxy['accounts']) }),
    },
    monitoring: monitoringService(monitoring),
  };
}
const STRATEGIES = ['fill-first', 'round-robin', 'least-recently-limited'];
function accountPolicy(value: unknown): AccountPolicy {
  if (!record(value) || !keys(value, ['minimumUsable', 'selection']))
    return fail();
  const { minimumUsable, selection } = value;
  if (
    minimumUsable !== undefined &&
    !(Number.isInteger(minimumUsable) && Number(minimumUsable) >= 1)
  )
    return fail();
  return {
    ...(minimumUsable === undefined
      ? {}
      : { minimumUsable: minimumUsable as number }),
    ...(selection === undefined
      ? {}
      : { selection: selectionPolicies(selection) }),
  };
}
function selectionPolicies(value: unknown): Record<string, AccountSelection> {
  if (!record(value)) return fail();
  const providers: Record<string, AccountSelection> = {};
  for (const [provider, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider)) return fail();
    providers[provider] = accountSelection(entry);
  }
  return providers;
}
function accountSelection(entry: unknown): AccountSelection {
  if (
    !record(entry) ||
    !keys(entry, ['strategy', 'order']) ||
    !STRATEGIES.includes(String(entry['strategy']))
  )
    return fail();
  const { order } = entry;
  if (
    order !== undefined &&
    !(Array.isArray(order) && order.every((label) => account(label)))
  )
    return fail();
  return {
    strategy: entry['strategy'] as AccountSelection['strategy'],
    ...(order ? { order: order as string[] } : {}),
  };
}
function monitoringService(
  value: unknown
): FleetDefinition['services']['monitoring'] {
  const fields = [
    'hubPort',
    'publicUrl',
    'managerAccount',
    'viewerAccount',
    'backups',
  ];
  if (!record(value) || !keys(value, fields) || value['hubPort'] !== 8443)
    return fail();
  const { publicUrl, managerAccount, viewerAccount } = value;
  if (!origin(publicUrl) || !account(managerAccount) || !account(viewerAccount))
    return fail();
  return {
    hubPort: 8443,
    publicUrl,
    managerAccount,
    viewerAccount,
    ...(value['backups'] === undefined
      ? {}
      : { backups: hubBackups(value['backups']) }),
  };
}
const text = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value);
function hubBackups(value: unknown): HubBackups {
  if (!record(value) || !keys(value, ['schedule', 'keep', 'storage']))
    return fail();
  const { schedule, keep } = value;
  if (
    !text(schedule, /^[0-9*/,-]+( [0-9*/,-]+){4}$/) ||
    !Number.isInteger(keep) ||
    Number(keep) < 1 ||
    Number(keep) > 365
  )
    return fail();
  return {
    schedule,
    keep: Number(keep),
    storage: backupStorage(value['storage']),
  };
}
function backupStorage(value: unknown): HubBackups['storage'] {
  if (
    !record(value) ||
    !keys(value, ['bucket', 'endpoint', 'region', 'forcePathStyle'])
  )
    return fail();
  const { bucket, endpoint, region, forcePathStyle } = value;
  if (
    !text(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/) ||
    !text(endpoint, /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/) ||
    !text(region, /^[a-z0-9-]{1,32}$/) ||
    (forcePathStyle !== undefined && typeof forcePathStyle !== 'boolean')
  )
    return fail();
  return {
    bucket,
    endpoint,
    region,
    ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
  };
}
const origin = (value: unknown): value is string =>
  typeof value === 'string' && /^https:\/\/[A-Za-z0-9.-]{1,253}$/.test(value);
const account = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(value);
function gitIdentity(value: unknown): GitIdentity {
  if (!record(value) || !keys(value, ['name', 'email', 'verifyRepository']))
    return fail();
  const { name, email, verifyRepository } = value;
  // Written into a quoted Git configuration value: no quote, backslash or
  // line break.
  if (typeof name !== 'string' || !/^[^"\\\n\r]{1,100}$/.test(name))
    return fail();
  if (!account(email)) return fail();
  if (
    verifyRepository !== undefined &&
    (typeof verifyRepository !== 'string' ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(
        verifyRepository
      ))
  )
    return fail();
  return {
    name,
    email,
    ...(verifyRepository === undefined ? {} : { verifyRepository }),
  };
}
function secrets(value: unknown): SecretsConfig {
  return parseSecretsConfig(value) ?? fail();
}
/** Says what is wrong with the block itself: a bucket has several settings. */
function state(value: unknown): BucketLocation {
  const bucket = parseLocation(value);
  if (bucket.kind === 'directory') return { directory: bucket.path };
  const { bucket: name, endpoint, region } = bucket;
  return {
    bucket: name,
    ...(endpoint ? { endpoint } : {}),
    ...(region ? { region } : {}),
    prefix: bucket.prefix,
  };
}
function source(value: unknown): FleetDefinition['source'] {
  if (
    !record(value) ||
    !keys(value, ['repository']) ||
    typeof value['repository'] !== 'string' ||
    !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+\.git$/.test(
      value['repository']
    )
  )
    return fail();
  return { repository: value['repository'] };
}
function baseline(ubuntu: unknown): FleetDefinition['ubuntu'] {
  if (!record(ubuntu) || !keys(ubuntu, ['release', 'architectures']))
    return fail();
  const accepted =
    typeof ubuntu['release'] === 'string'
      ? ubuntuRelease(ubuntu['release'])
      : undefined;
  if (
    !accepted ||
    JSON.stringify(ubuntu['architectures']) !==
      JSON.stringify(accepted.architectures)
  )
    return fail();
  return {
    release: accepted.release,
    architectures: [...accepted.architectures],
  };
}

/** The configuration as every machine keeps it at
 * ~/.config/dev-fleet/fleet.json: without the bucket. Only the devfleet CLI
 * on the manager reaches the bucket, and a launcher that still runs the
 * revision from before the block existed must go on accepting the file while
 * a sync is under way.
 */
export function installedDefinition(definition: FleetDefinition): string {
  const { state: _bucket, ...machine } = definition;
  return JSON.stringify(machine, null, 2) + '\n';
}

export function loadDefinition(path: string): FleetDefinition {
  try {
    return parseDefinition(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return fail();
  }
}
/** Local v1 roster supplies paths/requirements only for explicitly enrolled workers. */
export function enrolledRoster(
  definition: FleetDefinition,
  overrides: unknown
): FleetConfig {
  const roster = parseConfig(overrides);
  for (const node of roster.nodes) {
    const declared = definition.workers.find((entry) => entry.id === node.id);
    if (!declared)
      throw new FleetUsageError(
        'Roster contains a node that is not a declared worker. Add the worker to fleet.json in Git before rollout; the manager is never a roster node.'
      );
    if (declared.ssh !== node.ssh)
      throw new FleetUsageError(
        'Fleet SSH assignment conflicts with the local roster. Review the migration; discovery cannot overwrite explicit assignments.'
      );
  }
  return {
    ...roster,
    nodes: roster.nodes.map((node) => ({
      ...node,
      required: [
        ...new Set([
          ...node.required,
          ...(definition.worker?.requiredCapabilities ?? []),
        ]),
      ],
    })),
  };
}
