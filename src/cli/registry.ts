import { SOURCE_OPERATIONS } from './source-operations';
import type { CommandSpec } from './contracts';
import { searchCommands } from './search';

type Entry = [
  id: string,
  title: string,
  description: string,
  keywords: string[],
  mutation?: boolean,
];

function group(name: string, entries: Entry[]): CommandSpec[] {
  return entries.map(([id, title, description, keywords, mutation]) => ({
    id,
    title,
    description,
    group: name,
    keywords,
    args: id.split(' '),
    examples: [`devfleet ${id} --json`],
    mutation: mutation === true,
  }));
}

/** One flat, prefixed command surface shared by help, the palette and agents. */
export const COMMANDS: CommandSpec[] = [
  ...group('Fleet', [
    [
      'fleet-status',
      'Check this computer and registered nodes',
      'Read-only SSH, authentication, T3, VS Code and dependency checks for this manager and every roster node. --tailnet covers every visible Tailscale computer; --workers audits the canonical worker fleet.',
      ['health', 'doctor', 'ssh', 'auth', 'github', 'vscode', 't3', 'diagnose'],
    ],
    [
      'fleet-status --local',
      'Check this computer only',
      'Diagnose this process context without a roster or remote connections.',
      ['local', 'manager', 'health'],
    ],
    [
      'fleet-status --tailnet',
      'Check all Tailscale computers',
      'Discover every visible non-mobile Tailscale computer, then test reachability, pinned tools, configuration and service logins. Offline, unregistered and unverified computers fail coverage.',
      ['tailscale', 'tailnet', 'all', 'versions', 'codex', 'claude', 'login'],
    ],
    [
      'fleet-status --workers',
      'Check the canonical worker fleet',
      'Read-only canonical worker readiness, dependencies, services and authentication; lists every remaining gap.',
      ['workers', 'readiness', 'health', 'canonical'],
    ],
    [
      'fleet-discover',
      'Discover Tailscale computers',
      'List all computers visible to this Tailscale account, including offline devices. Excludes iOS, Android and tvOS; never writes a roster.',
      ['tailscale', 'tailnet', 'computers', 'machines'],
    ],
    [
      'fleet-sync',
      'Synchronize the enrolled Ubuntu fleet',
      'Manager push to all enrolled Ubuntu nodes at one approved revision over verified SSH: the commit the dev-fleet package was published from, with the fleet.json of the project it is run from. Interactive confirmation or --apply --yes. Readiness is verified separately.',
      ['ubuntu', 'enrollment', 'converge', 'sync'],
      true,
    ],
    [
      'fleet-state',
      'Check the fleet state and its bucket',
      'Read-only: where the fleet configuration, the roster and the approved revision are kept on this manager, and whether the bucket holds the same version. --example prints a fleet.json to start a project from; --export prints the configuration fleet-sync last applied; --import PATH stores one.',
      ['state', 'bucket', 's3', 'backup', 'litestream', 'configuration'],
    ],
    [
      'fleet-state --init',
      'Connect the bucket and restore or seed the fleet state',
      'Restore the fleet state from the bucket fleet.json names under "state" (or the one given with --bucket/--endpoint or --directory), or seed an empty bucket from this machine, and save the bucket and its credentials on this machine for runs it starts by itself. Credentials come from the environment or a terminal prompt.',
      ['state', 'bucket', 's3', 'setup', 'restore', 'new manager'],
      true,
    ],
    [
      'fleet-state --push',
      'Upload fleet state changes to the bucket',
      'Upload changes this manager made while the bucket was unreachable. Refuses when the bucket has changed since.',
      ['state', 'bucket', 'upload', 'replicate'],
      true,
    ],
    [
      'fleet-state --restore',
      'Replace the local fleet state with the bucket’s',
      'Discard this manager’s copy of the fleet state and download the bucket’s version. Needs --yes when this machine has changes the bucket does not hold.',
      ['state', 'bucket', 'restore', 'recover', 'disposable'],
      true,
    ],
    [
      'fleet-node-sync',
      'Sync this node',
      'Reconcile locked tools, the personal launcher, Codex proxy profile and owned T3 instances on this machine. Applies by default; --dry-run previews.',
      ['node', 'sync', 'proxy', 'tools'],
      true,
    ],
    [
      'fleet-repair',
      'Repair tools and configuration',
      'Inspect visible Tailscale computers and preview owner-managed repairs. --apply --yes executes eligible tools/config repairs and reruns diagnostics. Logins and host trust remain explicit operator steps.',
      ['fix', 'repair', 'sync', 'setup', 'versions', 'config', 'login'],
      true,
    ],
    [
      'fleet-repair --list',
      'Explore repairs and login commands',
      'List existing tool owners, automated repairs, native per-machine login commands and shared Vault access guidance. No roster or credentials required.',
      ['fix', 'repair', 'login', 'credentials', 'vault', 'catalog'],
    ],
    [
      'fleet-nodes',
      'Explore fleet nodes',
      'List and validate registered developer computers without contacting them. --onboard adds per-node setup instructions; --schema prints the roster JSON schema.',
      ['roster', 'list', 'machines', 'validate', 'schema'],
    ],
    [
      'fleet-nodes --onboard',
      'Explore onboarding instructions',
      'Get per-node SSH templates, VS Code guidance, authentication steps and safe verification commands.',
      ['setup', 'guide', 'instructions', 'vscode', 'connect'],
    ],
    [
      'fleet-nodes --schema',
      'Explore the fleet JSON schema',
      'Read the versioned roster schema for editors and agents.',
      ['agent', 'config', 'json', 'schema'],
    ],
    [
      'fleet-node-add',
      'Register a developer computer',
      'Preview or explicitly save an existing SSH alias, checkout path and per-machine capabilities. No SSH or cloud setup.',
      ['onboarding', 'register', 'new', 'setup', 'add'],
      true,
    ],
  ]),
  ...group('T3', [
    [
      't3-status',
      'Check T3 configuration drift',
      'Compare declared T3 provider instances with the configuration on this machine; exit 1 on drift.',
      ['t3', 'drift', 'status'],
    ],
    [
      't3-apply',
      'Reconcile T3 provider instances',
      'Create and update declared instances and remove previously owned instances absent from the definition. --dry-run plans; --plan-hash rejects stale plans; --import ID adopts an existing instance.',
      ['t3', 'apply', 'plan', 'import', 'reconcile'],
      true,
    ],
    [
      't3-cleanup',
      'Remove owned T3 instances',
      'Remove only provider instances recorded in personal ownership state. --dry-run previews.',
      ['t3', 'cleanup', 'remove'],
      true,
    ],
  ]),
  ...group(
    'Services',
    Object.entries(SOURCE_OPERATIONS).map(([id, operation]) => [
      id,
      operation.title,
      `${operation.description} Inspect devfleet ${id} help.`,
      operation.keywords,
      operation.mutation,
    ])
  ),
  ...group('Reference', [
    [
      'commands',
      'Explore the command catalog and agent contract',
      'Search the command index; the JSON document also carries the agent usage/safety contract, release metadata and exit codes.',
      ['search', 'help', 'llm', 'agent', 'api', 'index'],
    ],
  ]),
];

export function commandCatalog(search = '', group?: string): CommandSpec[] {
  return searchCommands(COMMANDS, search).filter(
    (command) => !group || command.group.toLowerCase() === group.toLowerCase()
  );
}
