import {
  parseWorkerPolicy,
  policyFault,
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
import { UBUNTU_RELEASES, ubuntuRelease } from './platform/ubuntu-release';
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
  /** How often its scheduled jobs run, when not the policy's default. */
  schedule?: { syncMinutes?: number; watchMinutes?: number };
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
  /** The worker that proves a revision new to the fleet before the others
   * receive it, when it is reachable. Without one, the first reachable
   * worker in the order above.
   */
  canary?: string;
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
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const MANAGER_USER = /^[a-z_][a-z0-9_.-]{0,31}$/;

/** What is wrong with a fleet definition: the first rule it breaks, where. */
export interface DefinitionProblem {
  /** Stable: DEFINITION_INVALID, DEFINITION_MISSING, DEFINITION_UNKNOWN,
   * DEFINITION_DUPLICATE or DEFINITION_UNREADABLE. */
  code: string;
  /** A JSONPath into fleet.json, such as `$.workers[1].network.sshPort`. */
  path: string;
  expected: string;
  /** The kind of value found, never more than a short excerpt of it. */
  actual: string;
}

export class DefinitionError extends FleetUsageError {
  constructor(readonly problem: DefinitionProblem) {
    super(
      `Invalid fleet definition at ${problem.path}: expected ${problem.expected}, found ${problem.actual}.`
    );
  }
}

/** A short description of a value, for a person to recognise it. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  const text = JSON.stringify(value);
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

function fail(
  path: string,
  expected: string,
  actual: unknown,
  code = actual === undefined ? 'DEFINITION_MISSING' : 'DEFINITION_INVALID'
): never {
  throw new DefinitionError({
    code,
    path,
    expected,
    actual: describe(actual),
  });
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!record(value)) return fail(path, 'an object', value);
  return value;
}

function keys(value: Record<string, unknown>, allowed: string[], path: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    fail(
      `${path}.${unknown}`,
      `one of ${allowed.filter((key) => key !== '$schema').join(', ')}`,
      value[unknown],
      'DEFINITION_UNKNOWN'
    );
}

function text(
  value: unknown,
  pattern: RegExp,
  path: string,
  expected: string
): string {
  if (typeof value !== 'string' || !pattern.test(value))
    return fail(path, expected, value);
  return value;
}

function constant<T>(value: unknown, wanted: T, path: string): T {
  if (JSON.stringify(value) !== JSON.stringify(wanted))
    return fail(path, JSON.stringify(wanted), value);
  return wanted;
}

function network(
  value: unknown,
  path: string
): NonNullable<MachineDefinition['network']> {
  const fields = object(value, path);
  keys(fields, ['tailscaleName', 'user', 'sshPort', 't3Port'], path);
  return {
    tailscaleName: text(
      fields['tailscaleName'],
      HOST,
      `${path}.tailscaleName`,
      'a host name'
    ),
    user: text(fields['user'], USER, `${path}.user`, 'a login name'),
    sshPort: port(fields['sshPort'], `${path}.sshPort`),
    t3Port: port(fields['t3Port'], `${path}.t3Port`),
  };
}
function port(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535)
    return fail(path, 'a port from 1 to 65535', value);
  return value as number;
}
function worker(value: unknown, path: string): MachineDefinition {
  const fields = object(value, path);
  keys(fields, ['id', 'ssh', 'os', 'network', 'toolProfiles'], path);
  const id = text(fields['id'], ID, `${path}.id`, 'a lowercase id');
  const ssh = text(fields['ssh'], HOST, `${path}.ssh`, 'an SSH host alias');
  // Workers are the Linux boxes; any other platform is not a worker.
  constant(fields['os'], 'linux', `${path}.os`);
  return {
    id,
    ssh,
    os: 'linux',
    ...(fields['network']
      ? { network: network(fields['network'], `${path}.network`) }
      : {}),
    ...(fields['toolProfiles'] === undefined
      ? {}
      : {
          toolProfiles:
            toolProfiles(fields['toolProfiles']) ??
            fail(
              `${path}.toolProfiles`,
              'a list of known tool profiles, each once',
              fields['toolProfiles']
            ),
        }),
  };
}
function manager(value: unknown): ManagerDefinition {
  const path = '$.manager';
  const fields = object(value, path);
  keys(fields, ['id', 'os', 'network', 'neverSleepOnPower', 'schedule'], path);
  const id = text(fields['id'], ID, `${path}.id`, 'a lowercase id');
  // The manager must be the Mac: a Linux machine is a worker.
  constant(fields['os'], 'macOS', `${path}.os`);
  const net = object(fields['network'], `${path}.network`);
  keys(net, ['tailscaleName', 'user'], `${path}.network`);
  const tailscaleName = text(
    net['tailscaleName'],
    HOST,
    `${path}.network.tailscaleName`,
    'a host name'
  );
  const user = text(
    net['user'],
    MANAGER_USER,
    `${path}.network.user`,
    'a login name'
  );
  constant(fields['neverSleepOnPower'], true, `${path}.neverSleepOnPower`);
  return {
    id,
    os: 'macOS',
    network: { tailscaleName, user },
    neverSleepOnPower: true,
    ...(fields['schedule'] === undefined
      ? {}
      : { schedule: schedule(fields['schedule'], `${path}.schedule`) }),
  };
}

function schedule(
  value: unknown,
  path: string
): NonNullable<ManagerDefinition['schedule']> {
  const fields = object(value, path);
  keys(fields, ['syncMinutes', 'watchMinutes'], path);
  const result: NonNullable<ManagerDefinition['schedule']> = {};
  for (const key of ['syncMinutes', 'watchMinutes'] as const) {
    const minutes = fields[key];
    if (minutes === undefined) continue;
    if (
      !Number.isInteger(minutes) ||
      Number(minutes) < 5 ||
      Number(minutes) > 1440
    )
      fail(`${path}.${key}`, 'whole minutes from 5 to 1440', minutes);
    result[key] = minutes as number;
  }
  return result;
}
export function parseDefinition(value: unknown): FleetDefinition {
  const fields = object(value, '$');
  keys(
    fields,
    [
      '$schema',
      'version',
      'source',
      'secrets',
      'state',
      'manager',
      'workers',
      'canary',
      'services',
      'ubuntu',
      'worker',
      'ides',
      't3',
      'git',
      'notify',
      'github',
    ],
    '$'
  );
  constant(fields['version'], 3, '$.version');
  const list = fields['workers'];
  if (!Array.isArray(list) || list.length > 64)
    return fail('$.workers', 'an array of at most 64 workers', list);
  const lead = manager(fields['manager']);
  const workers = list.map((entry, index) =>
    worker(entry, `$.workers[${index}]`)
  );
  const seen = new Set([lead.id]);
  workers.forEach((entry, index) => {
    if (seen.has(entry.id))
      fail(
        `$.workers[${index}].id`,
        'an id no other machine has',
        entry.id,
        'DEFINITION_DUPLICATE'
      );
    seen.add(entry.id);
  });
  return {
    version: 3,
    source: source(fields['source']),
    secrets: secrets(fields['secrets']),
    ...(fields['state'] === undefined ? {} : { state: state(fields['state']) }),
    manager: lead,
    workers,
    ...(fields['canary'] === undefined
      ? {}
      : { canary: canary(fields['canary'], workers) }),
    services: services(fields['services']),
    ubuntu: baseline(fields['ubuntu']),
    ...(fields['worker'] === undefined
      ? {}
      : { worker: policy(fields['worker']) }),
    // Kept only when named: an earlier revision must still read the copy.
    ...(fields['ides'] === undefined
      ? {}
      : { ides: block('$.ides', () => parseIdes(fields['ides'])) }),
    ...(fields['t3'] === undefined
      ? {}
      : { t3: block('$.t3', () => parseT3(fields['t3'])) }),
    ...(fields['git'] === undefined ? {} : { git: gitIdentity(fields['git']) }),
    ...(fields['notify'] === undefined
      ? {}
      : {
          notify:
            parseNotify(fields['notify']) ??
            fail(
              '$.notify',
              'targets (webhook, ntfy) and repeatHours from 0 to 720',
              fields['notify']
            ),
        }),
    ...(fields['github'] === undefined
      ? {}
      : {
          github: block('$.github', () => parseGithubPolicy(fields['github'])),
        }),
  };
}
/** The canary is one of the declared workers. */
function canary(value: unknown, workers: MachineDefinition[]): string {
  if (typeof value !== 'string' || !workers.some((entry) => entry.id === value))
    return fail('$.canary', 'the id of a declared worker', value);
  return value;
}
/** Singleton services name no host: they always run on the manager. */
function services(value: unknown): FleetDefinition['services'] {
  const fields = object(value, '$.services');
  keys(fields, ['proxy', 'monitoring'], '$.services');
  const proxy = object(fields['proxy'], '$.services.proxy');
  keys(proxy, ['endpoint', 'accounts'], '$.services.proxy');
  return {
    proxy: {
      endpoint: text(
        proxy['endpoint'],
        ORIGIN,
        '$.services.proxy.endpoint',
        'an https origin without a path'
      ),
      ...(proxy['accounts'] === undefined
        ? {}
        : { accounts: accountPolicy(proxy['accounts']) }),
    },
    monitoring: monitoringService(fields['monitoring']),
  };
}
/** A block parsed elsewhere: its own message says what it expects. */
function block<T>(path: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DefinitionError || !(error instanceof Error))
      throw error;
    return fail(path, error.message, 'something else');
  }
}
const STRATEGIES = ['fill-first', 'round-robin', 'least-recently-limited'];
function accountPolicy(value: unknown): AccountPolicy {
  const path = '$.services.proxy.accounts';
  const fields = object(value, path);
  keys(fields, ['minimumUsable', 'selection'], path);
  const { minimumUsable, selection } = fields;
  if (
    minimumUsable !== undefined &&
    !(Number.isInteger(minimumUsable) && Number(minimumUsable) >= 1)
  )
    fail(`${path}.minimumUsable`, 'an integer of at least 1', minimumUsable);
  return {
    ...(minimumUsable === undefined
      ? {}
      : { minimumUsable: minimumUsable as number }),
    ...(selection === undefined
      ? {}
      : { selection: selectionPolicies(selection, `${path}.selection`) }),
  };
}
function selectionPolicies(
  value: unknown,
  path: string
): Record<string, AccountSelection> {
  const fields = object(value, path);
  const providers: Record<string, AccountSelection> = {};
  for (const [provider, entry] of Object.entries(fields)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider))
      fail(`${path}.${provider}`, 'a provider name', provider);
    providers[provider] = accountSelection(entry, `${path}.${provider}`);
  }
  return providers;
}
function accountSelection(entry: unknown, path: string): AccountSelection {
  const fields = object(entry, path);
  keys(fields, ['strategy', 'order'], path);
  if (!STRATEGIES.includes(String(fields['strategy'])))
    fail(
      `${path}.strategy`,
      `one of ${STRATEGIES.join(', ')}`,
      fields['strategy']
    );
  const { order } = fields;
  if (
    order !== undefined &&
    !(
      Array.isArray(order) &&
      order.every((label) => typeof label === 'string' && ACCOUNT.test(label))
    )
  )
    fail(`${path}.order`, 'a list of account email addresses', order);
  return {
    strategy: fields['strategy'] as AccountSelection['strategy'],
    ...(order ? { order: order as string[] } : {}),
  };
}
function monitoringService(
  value: unknown
): FleetDefinition['services']['monitoring'] {
  const path = '$.services.monitoring';
  const fields = object(value, path);
  keys(
    fields,
    ['hubPort', 'publicUrl', 'managerAccount', 'viewerAccount', 'backups'],
    path
  );
  constant(fields['hubPort'], 8443, `${path}.hubPort`);
  return {
    hubPort: 8443,
    publicUrl: text(
      fields['publicUrl'],
      ORIGIN,
      `${path}.publicUrl`,
      'an https origin without a path'
    ),
    managerAccount: text(
      fields['managerAccount'],
      ACCOUNT,
      `${path}.managerAccount`,
      'an email address'
    ),
    viewerAccount: text(
      fields['viewerAccount'],
      ACCOUNT,
      `${path}.viewerAccount`,
      'an email address'
    ),
    ...(fields['backups'] === undefined
      ? {}
      : { backups: hubBackups(fields['backups'], `${path}.backups`) }),
  };
}
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,253}$/;
const ACCOUNT = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,253}$/;
function hubBackups(value: unknown, path: string): HubBackups {
  const fields = object(value, path);
  keys(fields, ['schedule', 'keep', 'storage'], path);
  const { keep } = fields;
  if (!Number.isInteger(keep) || Number(keep) < 1 || Number(keep) > 365)
    fail(`${path}.keep`, 'an integer from 1 to 365', keep);
  return {
    schedule: text(
      fields['schedule'],
      /^[0-9*/,-]+( [0-9*/,-]+){4}$/,
      `${path}.schedule`,
      'a cron expression of five fields'
    ),
    keep: Number(keep),
    storage: backupStorage(fields['storage'], `${path}.storage`),
  };
}
function backupStorage(value: unknown, path: string): HubBackups['storage'] {
  const fields = object(value, path);
  keys(fields, ['bucket', 'endpoint', 'region', 'forcePathStyle'], path);
  const { forcePathStyle } = fields;
  if (forcePathStyle !== undefined && typeof forcePathStyle !== 'boolean')
    fail(`${path}.forcePathStyle`, 'true or false', forcePathStyle);
  return {
    bucket: text(
      fields['bucket'],
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
      `${path}.bucket`,
      'an S3 bucket name'
    ),
    endpoint: text(
      fields['endpoint'],
      /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/,
      `${path}.endpoint`,
      'an https origin, with a port if needed'
    ),
    region: text(
      fields['region'],
      /^[a-z0-9-]{1,32}$/,
      `${path}.region`,
      'a region name'
    ),
    ...(forcePathStyle === undefined
      ? {}
      : { forcePathStyle: forcePathStyle as boolean }),
  };
}
function gitIdentity(value: unknown): GitIdentity {
  const path = '$.git';
  const fields = object(value, path);
  keys(fields, ['name', 'email', 'verifyRepository'], path);
  const { verifyRepository } = fields;
  return {
    // Written into a quoted Git configuration value: no quote, backslash or
    // line break.
    name: text(
      fields['name'],
      /^[^"\\\n\r]{1,100}$/,
      `${path}.name`,
      'a name without quotes, backslashes or line breaks'
    ),
    email: text(fields['email'], ACCOUNT, `${path}.email`, 'an email address'),
    ...(verifyRepository === undefined
      ? {}
      : {
          verifyRepository: text(
            verifyRepository,
            /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
            `${path}.verifyRepository`,
            'an https URL of a GitHub repository'
          ),
        }),
  };
}
function secrets(value: unknown): SecretsConfig {
  return (
    parseSecretsConfig(value) ??
    fail(
      '$.secrets',
      'a provider block: env, file, sops or vault with its settings',
      value
    )
  );
}
const POLICY: Record<string, string> = {
  requiredCapabilities:
    'every capability: github, vault, t3, toolchain, workstation, worker',
  githubLogin: 'a GitHub login',
  vaultUser: 'a Vault user name',
  toolchain: '"mise.lock"',
  agentProfile: '"proxy"',
  unattendedSudo: 'true',
  persistentT3: 'true',
  neverSleep: 'true',
  toolProfiles: 'a list of known tool profiles, each once',
  tools: 'a list of tool names from dev-fleet’s mise.toml, each once',
};
function policy(value: unknown): WorkerPolicy {
  const fields = object(value, '$.worker');
  keys(fields, Object.keys(POLICY), '$.worker');
  const field = policyFault(fields);
  if (field !== null)
    fail(`$.worker.${field}`, POLICY[field] ?? 'a valid value', fields[field]);
  return parseWorkerPolicy(fields);
}
/** Says what is wrong with the block itself: a bucket has several settings. */
function state(value: unknown): BucketLocation {
  let bucket;
  try {
    bucket = parseLocation(value);
  } catch (error) {
    return fail(
      '$.state',
      error instanceof Error ? error.message : 'a bucket or a directory',
      value
    );
  }
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
  const fields = object(value, '$.source');
  keys(fields, ['repository'], '$.source');
  return {
    repository: text(
      fields['repository'],
      /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+\.git$/,
      '$.source.repository',
      'an https URL of a Git repository ending in .git'
    ),
  };
}
function baseline(ubuntu: unknown): FleetDefinition['ubuntu'] {
  const fields = object(ubuntu, '$.ubuntu');
  keys(fields, ['release', 'architectures'], '$.ubuntu');
  const accepted =
    typeof fields['release'] === 'string'
      ? ubuntuRelease(fields['release'])
      : undefined;
  if (!accepted)
    return fail(
      '$.ubuntu.release',
      `one of ${UBUNTU_RELEASES.map((entry) => entry.release).join(', ')}`,
      fields['release']
    );
  constant(
    fields['architectures'],
    accepted.architectures,
    '$.ubuntu.architectures'
  );
  return {
    release: accepted.release,
    architectures: [...accepted.architectures],
  };
}

/** The first rule a fleet.json breaks, or null when it is valid. */
export function definitionProblem(value: unknown): DefinitionProblem | null {
  try {
    parseDefinition(value);
    return null;
  } catch (error) {
    if (error instanceof DefinitionError) return error.problem;
    throw error;
  }
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
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail(
      '$',
      'a readable JSON file',
      'unreadable',
      'DEFINITION_UNREADABLE'
    );
  }
  return parseDefinition(value);
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
