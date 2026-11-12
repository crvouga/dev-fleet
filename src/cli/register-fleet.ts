import type { Command } from 'commander';
import type { CliOptions } from './options';
import type { CommandOutcome } from './contracts';
import type { Settings } from './settings';
import { resolveSettings } from './settings';
import { executeFleet } from './fleet';
import { fleetSync, type FleetSyncOptions } from './fleet-sync';
import { syncNode, type NodeSyncOptions } from './node-sync';
import { fleetState, type FleetStateOptions } from './fleet-state';
import { fleetAccounts, type FleetAccountsOptions } from './fleet-accounts';
import { fleetReport, type FleetReportOptions } from './fleet-report';
import { fleetWatch, watchServices } from './fleet-watch';
import type { Check, NodeReport } from '../types';
import { fleet } from '../fleet-config';
import { registerGithubVerify } from './github-verify';
import { fleetRestore, type FleetRestoreOptions } from './fleet-restore';
import { fleetValidate, type FleetValidateOptions } from './fleet-validate';
import {
  fleetManifest,
  manifestServices,
  type FleetManifestOptions,
} from './fleet-manifest';
import {
  fleetNodeSeed,
  seedServices,
  type NodeSeedOptions,
} from './fleet-node-seed';
import {
  fleetNodeReplace,
  fleetNodeRetire,
  lifecycleServices,
  type NodeLifecycleOptions,
} from './fleet-node-lifecycle';
import {
  fleetNodePark,
  fleetNodeResume,
  parkServices,
  type NodeParkOptions,
} from './fleet-node-park';

type Complete = (outcome: CommandOutcome) => void;

interface Registration {
  program: Command;
  defaults: Settings;
  complete: Complete;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function targetOptions(command: Command): Command {
  return command
    .option('--node <id>', 'Select a registered node; repeatable', collect, [])
    .option('--local', 'This manager only; no roster or SSH required')
    .option('--timeout <ms>', 'Per-node deadline, 1000–1800000 milliseconds');
}

function withSettings(defaults: Settings, options: CliOptions) {
  return resolveSettings({
    ...defaults,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.config ? { config: options.config } : {}),
  });
}

/** Internal fleet actions are selected by flags; the public surface stays flat. */
function fleetAction(name: string, options: CliOptions): string {
  if (name === 'fleet-status')
    return options.tailnet || options.workers ? 'health' : 'doctor';
  if (name === 'fleet-repair') return options.list ? 'repairs' : 'repair';
  if (name === 'fleet-nodes')
    return options.onboard ? 'onboard' : options.schema ? 'schema' : 'nodes';
  if (name === 'fleet-node-add') return 'add';
  return 'discover';
}

function register(
  { program, defaults, complete }: Registration,
  name: string,
  description: string
): Command {
  return program
    .command(name)
    .description(description)
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals<CliOptions>();
      const settings = await withSettings(defaults, options);
      complete(
        await executeFleet(
          fleetAction(name, options),
          { ...options, ...(options.workers ? { managed: true } : {}) },
          settings
        )
      );
    });
}

function registerStatus(registration: Registration) {
  targetOptions(
    register(
      registration,
      'fleet-status',
      'Check this computer and registered nodes without changing them'
    )
  )
    .option('--all', 'Explicit spelling of the default roster scope')
    .option(
      '--tailnet',
      'Check every visible Tailscale computer instead of the roster'
    )
    .option(
      '--workers',
      'Audit the canonical worker fleet against the published reference'
    )
    .option(
      '--require <capabilities>',
      'Manager capabilities, comma separated, or none'
    )
    .option('--strict', 'Warnings and skipped checks also produce exit 1')
    .addHelpText(
      'after',
      '\nRead-only. --local, --node and --all select roster scope; --tailnet and --workers check Tailscale computers and never take a roster scope.'
    );
}

function registerRepair(registration: Registration) {
  targetOptions(
    register(
      registration,
      'fleet-repair',
      'Preview owner-managed repairs; --apply --yes executes them'
    )
  )
    .option('--list', 'Print the static repair and login catalog instead')
    .option('--all', 'Every visible Tailscale computer (default)')
    .option(
      '--require <capabilities>',
      'Local only: manager capabilities, comma separated, or none'
    )
    .option(
      '--repair <ids>',
      'workspace,workstation,providers; comma separated'
    )
    .option(
      '--plan-hash <sha256>',
      'Require the reviewed plan to match current diagnostics'
    )
    .option(
      '--script',
      'Generate a reviewable POSIX script without executing it'
    )
    .option('--strict', 'Warnings and skipped checks also produce exit 1')
    .option('--apply', 'Authorize the displayed repair plan; requires --yes')
    .option('--yes', 'Confirm an explicitly requested --apply operation')
    .addHelpText(
      'after',
      '\nExample: devfleet fleet-repair --local --repair workspace --plan-hash REVIEWED_SHA256 --apply --yes --json'
    );
}

function registerNodes(registration: Registration) {
  register(
    registration,
    'fleet-nodes',
    'List registered developer computers; --onboard and --schema add guidance'
  )
    .option('--node <id>', 'Select a registered node; repeatable', collect, [])
    .option(
      '--onboard',
      'Per-node SSH, VS Code and authentication instructions'
    )
    .option('--schema', 'Print the versioned roster JSON schema');
  register(
    registration,
    'fleet-node-add',
    'Register an existing computer in the local roster; writes need --apply --yes'
  )
    .requiredOption('--id <name>', 'Unique lowercase node ID')
    .requiredOption(
      '--ssh <alias>',
      'Existing OpenSSH alias; never writes SSH configuration'
    )
    .requiredOption('--path <path>', 'Absolute POSIX checkout path on the node')
    .option(
      '--runtime <path>',
      'Optional absolute Node/Bun runtime; defaults to node on SSH PATH'
    )
    .option(
      '--require <capabilities>',
      'Required capabilities, comma separated, or none'
    )
    .option('--apply', 'Write the roster; requires --yes')
    .option('--yes', 'Confirm an explicitly requested --apply operation');
}

function registerSync({ program, defaults, complete }: Registration) {
  program
    .command('fleet-sync')
    .description(
      'Synchronize the enrolled Ubuntu fleet from this manager over verified SSH'
    )
    .option(
      '--revision <sha>',
      'Converge to an exact source commit; defaults to the commit the dev-fleet package you run was published from'
    )
    .option(
      '--rollback',
      'Converge to the revision applied before the current one (fleet state); the revision, tools and T3 go back, system packages roll forward only'
    )
    .option(
      '--node <id>',
      'Explicit enrolled remote target; repeatable',
      collect,
      []
    )
    .option(
      '--vault-password-login',
      'Opt-in: log a worker without a token of its own in with the shared Vault user, on its own terminal'
    )
    .option(
      '--restart-busy',
      'Restart a worker T3 for a new release or policy even while agent turns run, which ends them; by default the restart waits until T3 is idle'
    )
    .option(
      '--canary <id>',
      'The worker that proves a new revision first when it is reachable; defaults to canary in fleet.json, then the first worker'
    )
    .option(
      '--all',
      'Explicit spelling of the default enrolled fleet scope; never discovered peers'
    )
    .option(
      '--dry-run',
      'Read-only plan; no authentication, enrollment, installation or scheduling'
    )
    .option(
      '--apply',
      'Accepted for compatibility; fleet-sync applies by default (schedule writes still need --apply --yes)'
    )
    .option('--yes', 'Accepted for compatibility with --apply')
    .option(
      '--maintenance-reboot',
      'Reboot each worker whose installed updates wait for a reboot: one at a time, canary first, only while it runs no agent turn, verified ready before the next'
    )
    .option(
      '--force',
      'With --maintenance-reboot: reboot a worker even while agent turns run (they end)'
    )
    .option(
      '--take-over',
      'Make this machine the manager while another one still holds the manager lease'
    )
    .option(
      '--schedule <action>',
      'Manager-only schedule: enable, pause, resume, disable, status'
    )
    .option(
      '--only <scope>',
      'accounts: only the account-derived configuration, on every node at once, without a full sync'
    )
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals<
        FleetSyncOptions & Partial<Settings>
      >();
      complete(
        await fleetSync(options, {
          ...defaults,
          ...(options.config ? { config: options.config } : {}),
        })
      );
    });
  program
    .command('fleet-node-sync')
    .description(
      'Reconcile this node’s locked tools, launcher, Codex proxy profile and T3 instances; applies by default'
    )
    .option(
      '--id <name>',
      'Stable node name; defaults to this machine hostname'
    )
    .option('--revision <sha>', 'Reviewed commit; defaults to checkout HEAD')
    .option('--dry-run', 'Preview without changing this node')
    .option('--t3-home <path>', 'T3 base directory')
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals<
        NodeSyncOptions & Partial<Settings>
      >();
      complete(await syncNode(options, await withSettings(defaults, options)));
    });
}

function registerState({ program, complete }: Registration) {
  program
    .command('fleet-state')
    .description(
      'Show where the fleet state is kept and whether the bucket holds it; flags connect, upload and restore'
    )
    .option(
      '--init',
      'Connect the bucket: restore the fleet state from it, or seed it from this machine, and save its credentials for runs this machine starts by itself'
    )
    .option(
      '--bucket <name>',
      'With --init, when no fleet.json names the bucket: S3-compatible bucket name'
    )
    .option(
      '--endpoint <url>',
      'With --init: https origin of the S3 service; omit for AWS S3'
    )
    .option('--region <name>', 'With --init: bucket region, such as auto')
    .option('--prefix <prefix>', 'With --init: key prefix; default dev-fleet')
    .option(
      '--directory <path>',
      'With --init: replicate to a directory instead of a bucket'
    )
    .option(
      '--import <path>',
      'Store a fleet configuration without running fleet-sync'
    )
    .option(
      '--export',
      'Print the stored fleet configuration: the one fleet-sync last applied'
    )
    .option('--example', 'Print an example fleet.json to start a project from')
    .option('--push', 'Upload this machine’s changes to the bucket')
    .option(
      '--restore',
      'Replace this machine’s copy with the bucket’s version'
    )
    .option('--yes', 'With --restore: discard changes the bucket does not hold')
    .option(
      '--timestamp <time>',
      'With --restore: the version the bucket held at this time, uploaded again as the current one (a damaged replica)'
    )
    .option(
      '--take-over',
      'With --init or --import: change the fleet state while another manager still holds the manager lease'
    )
    .addHelpText(
      'after',
      '\nRead-only without a flag. The bucket is the one named under "state" in fleet.json. Every command reads its credentials from DEVFLEET_BUCKET_ACCESS_KEY_ID and DEVFLEET_BUCKET_SECRET_ACCESS_KEY; --init also asks on the terminal. They are never taken from arguments.'
    )
    .action(async (_options, command: Command) => {
      complete(await fleetState(command.optsWithGlobals<FleetStateOptions>()));
    });
}

function registerReport({ program, complete }: Registration) {
  program
    .command('fleet-report')
    .description(
      'Report how reliably fleet-sync ran: success rate, duration, failing checks and time not ready'
    )
    .option('--since <duration>', 'How far back: 30d (default), 12h or 90m')
    .action((_options, command: Command) => {
      complete(fleetReport(command.optsWithGlobals<FleetReportOptions>()));
    });
}

function registerWatch({ program, defaults, complete }: Registration) {
  program
    .command('fleet-watch')
    .description(
      "Check the workers and notify the fleet's targets when one becomes unhealthy or recovers"
    )
    .option('--test', 'Send one test notification to every target and stop')
    .addHelpText(
      'after',
      '\nRuns fleet-status --workers, compares it with the previous run kept in the bucket and notifies only on a change (and again every repeatHours while a worker stays unhealthy). Targets come from "notify" in fleet.json; their addresses are secrets. Every run stores a heartbeat in the bucket for an off-machine check.'
    )
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals<
        CliOptions & { test?: boolean }
      >();
      const settings = await withSettings(defaults, options);
      const status = async (): Promise<NodeReport[]> => {
        const report = await executeFleet(
          'health',
          { ...options, workers: true, managed: true },
          settings
        );
        const data = report.data as { nodes?: NodeReport[] };
        return data.nodes ?? [];
      };
      const autoPark = async (reports: NodeReport[]): Promise<Check[]> => {
        const checks: Check[] = [];
        for (const report of reports) {
          if (
            !report.checks.some(
              (check) => check.id === 'worker:idle' && check.status === 'warn'
            )
          )
            continue;
          const worker = fleet.workers.find(
            (entry) =>
              entry.id === report.node ||
              entry.network?.tailscaleName === report.node
          );
          if (!worker) continue;
          const parked = await fleetNodePark(
            { id: worker.id },
            parkServices(settings.config, () =>
              Promise.reject(new Error('fleet-watch never resumes a worker'))
            )
          );
          checks.push({
            id: 'worker:auto-park',
            status: parked.exitCode === 0 ? 'pass' : 'warn',
            summary:
              parked.exitCode === 0
                ? `${worker.id} was idle longer than declared and is parked.`
                : 'WORKER_AUTO_PARK_REFUSED',
            ...(parked.exitCode === 0
              ? {}
              : {
                  remedy: {
                    action: `fleet-node-park refused ${worker.id}; run devfleet fleet-node-park --id ${worker.id} to see why.`,
                  },
                }),
          });
        }
        return checks;
      };
      complete(
        await fleetWatch(
          { ...(options.test ? { test: true } : {}) },
          {
            ...watchServices(status),
            ...(fleet.parking?.autoPark ? { autoPark } : {}),
          }
        )
      );
    });
}

function registerRestore({ program, complete }: Registration) {
  program
    .command('fleet-restore')
    .description(
      'Bring a replacement manager back from the bucket (docs/manager-recovery.md)'
    )
    .option(
      '--dry-run',
      'Verify every prerequisite and list what would be restored; change nothing'
    )
    .action(async (_options, command: Command) => {
      complete(
        await fleetRestore(command.optsWithGlobals<FleetRestoreOptions>())
      );
    });
}

function registerValidate({ program, complete }: Registration) {
  program
    .command('fleet-validate')
    .description(
      'Validate fleet.json and name the field that breaks a rule; contacts nothing'
    )
    .option(
      '--file <path>',
      'The fleet.json to validate; defaults to the project’s'
    )
    .option(
      '--ansible',
      'Also render the Ansible inventory and syntax-check every playbook with the pinned Ansible'
    )
    .action(async (_options, command: Command) => {
      complete(
        await fleetValidate(command.optsWithGlobals<FleetValidateOptions>())
      );
    });
}

function registerLifecycle({ program, defaults, complete }: Registration) {
  const action =
    (name: 'replace' | 'retire') =>
    async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        NodeLifecycleOptions & CliOptions
      >();
      const settings = await withSettings(defaults, options);
      const services = lifecycleServices(settings.config);
      complete(
        name === 'replace'
          ? await fleetNodeReplace(options, services)
          : await fleetNodeRetire(options, services)
      );
    };
  program
    .command('fleet-node-replace')
    .description(
      'Put a fresh machine in place of a worker under the same id; writes need --apply --yes'
    )
    .requiredOption('--id <name>', 'The declared worker being replaced')
    .option(
      '--host-key <key>',
      'The new machine’s SSH host key, "TYPE BASE64", verified out of band or printed by fleet-node-seed'
    )
    .option('--apply', 'Change the manager and Vault; requires --yes')
    .option('--yes', 'Confirm an explicitly requested --apply operation')
    .action(action('replace'));
  program
    .command('fleet-node-retire')
    .description(
      'Take a worker out of the fleet: revoke its token, forget its host key and roster entry; writes need --apply --yes'
    )
    .requiredOption('--id <name>', 'The declared worker to retire')
    .option(
      '--apply',
      'Change the manager, Vault and the fleet state; requires --yes'
    )
    .option('--yes', 'Confirm an explicitly requested --apply operation')
    .action(action('retire'));
  const parking =
    (name: 'park' | 'resume') =>
    async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<NodeParkOptions & CliOptions>();
      const settings = await withSettings(defaults, options);
      const services = parkServices(settings.config, (id) =>
        fleetSync(
          {
            node: [id],
            apply: true,
            yes: true,
            nonInteractive: true,
            ...(options.json ? { json: true } : {}),
          },
          {
            ...defaults,
            ...(options.config ? { config: options.config } : {}),
          }
        )
      );
      complete(
        name === 'park'
          ? await fleetNodePark(options, services)
          : await fleetNodeResume(options, services)
      );
    };
  program
    .command('fleet-node-park')
    .description(
      'Park a worker that is stopped or destroyed on purpose: it is no longer contacted, never the canary and does not fail the fleet'
    )
    .requiredOption('--id <name>', 'The declared worker to park')
    .option(
      '--force',
      'Park although agent turns are under way on it, or cannot be counted'
    )
    .option('--dry-run', 'Say what would change; change nothing')
    .action(parking('park'));
  program
    .command('fleet-node-resume')
    .description(
      'Bring a parked worker back: run the declared start command, then fleet-sync that worker and verify it'
    )
    .requiredOption('--id <name>', 'The declared worker to resume')
    .option('--dry-run', 'Say what would change; change nothing')
    .action(parking('resume'));
  program
    .command('fleet-node-seed')
    .description(
      'Write cloud-init (or autoinstall) user data a new worker joins the fleet with by itself'
    )
    .requiredOption('--id <name>', 'The declared worker to seed')
    .requiredOption(
      '--output <path>',
      'Where to write the seed (mode 600); it holds a single-use auth key and is never printed'
    )
    .option(
      '--public-key <path>',
      'The manager public key to authorize; default ~/.ssh/id_ed25519.pub'
    )
    .option('--autoinstall', 'An Ubuntu autoinstall file, for bare metal')
    .option(
      '--apply',
      'Also pin the seed host key on this manager; requires --yes'
    )
    .option('--yes', 'Confirm an explicitly requested --apply operation')
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<NodeSeedOptions & CliOptions>();
      const settings = await withSettings(defaults, options);
      complete(await fleetNodeSeed(options, seedServices(settings.config)));
    });
}

function registerManifest({ program, defaults, complete }: Registration) {
  program
    .command('fleet-manifest')
    .description(
      'Measure what a worker is made of and check it against the pins and a fresh build'
    )
    .requiredOption('--id <name>', 'The enrolled worker to measure')
    .option(
      '--reference <path>',
      'A fleet-manifest --json of a fresh build of the same revision'
    )
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<
        FleetManifestOptions & CliOptions
      >();
      const settings = await withSettings(defaults, options);
      complete(await fleetManifest(options, manifestServices(settings.config)));
    });
}

export function registerFleet(
  program: Command,
  defaults: Settings,
  complete: Complete
): void {
  const registration = { program, defaults, complete };
  registerStatus(registration);
  register(
    registration,
    'fleet-discover',
    'List computers visible through Tailscale, including offline devices'
  );
  registerSync(registration);
  registerState(registration);
  registerReport(registration);
  registerWatch(registration);
  registerRestore(registration);
  registerValidate(registration);
  registerLifecycle(registration);
  registerManifest(registration);
  registerRepair(registration);
  registerNodes(registration);
  registerAccounts(registration);
  registerGithubVerify(program, complete);
}

function registerAccounts({ program, defaults, complete }: Registration) {
  program
    .command('fleet-accounts [args...]')
    .description(
      'List the provider accounts signed in on the CLI proxy and their state; add, sign in again or remove one'
    )
    .option('--diff', 'Also compare what this machine offers with the roster')
    .option('--add', 'Sign a new account in: --add PROVIDER')
    .option('--relogin', 'Sign one account in again: --relogin PROVIDER INDEX')
    .option('--remove', 'Remove one account: --remove PROVIDER INDEX')
    .option(
      '--remove-native-logins',
      'Remove provider logins agent CLIs keep outside the proxy on this machine; needs --yes'
    )
    .option('--yes', 'Confirm --remove-native-logins')
    .action(async (args: string[], _options, command: Command) => {
      const options = command.optsWithGlobals<
        FleetAccountsOptions & CliOptions
      >();
      complete(
        await fleetAccounts(
          options,
          args,
          await withSettings(defaults, options)
        )
      );
    });
}
