import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseDefinition, type FleetDefinition } from '../definition';
import { definitionSource } from '../fleet-config';
import { managerHost } from '../platform/manager-host';
import { makeReport, renderReport, reportExitCode } from '../report';
import { runCommand } from '../runner';
import { connection } from '../state/connection';
import { managerHolder } from '../state/holder';
import { stateRoot } from '../state/paths';
import { pull, standing, type StateContext } from '../state/sync';
import type { Check, Runner } from '../types';
import type { CommandOutcome } from './contracts';

export interface FleetRestoreOptions {
  dryRun?: boolean;
  json?: boolean;
}

export interface FleetRestoreServices {
  run: Runner;
  env: NodeJS.ProcessEnv;
  home: string;
  holder?: string | null;
}

/** What a replacement manager gets back, in the order it is restored. */
export const RESTORES = [
  {
    what: 'Fleet state (roster, approved revision, configuration last applied)',
    how: 'Downloaded from the bucket by this command.',
  },
  {
    what: 'Machine policy, toolchain and checkouts',
    how: 'Rebuilt from Git by devfleet fleet-sync.',
  },
  {
    what: 'CLI proxy state (provider logins, keys, Tailscale identity)',
    how: 'Restored from its encrypted snapshots by devfleet cliproxy install (vault secrets provider only).',
  },
  {
    what: 'Monitoring hub',
    how: 'Recreated by devfleet fleet-sync with its accounts and systems; metric history is lost.',
  },
  {
    what: 'T3 ownership record',
    how: 'Adopted again with devfleet t3-apply --import ID.',
  },
];

const check = (
  id: string,
  ok: boolean,
  [pass, failure, action, missing = 'fail']: [
    string,
    string,
    string,
    ('fail' | 'warn')?,
  ]
): Check =>
  ok
    ? { id, status: 'pass', summary: pass }
    : { id, status: missing, summary: failure, remedy: { action } };

function definition(services: FleetRestoreServices): FleetDefinition | null {
  const source = definitionSource(services.env, services.home);
  if (source.kind !== 'file' || !existsSync(source.path)) return null;
  try {
    return parseDefinition(JSON.parse(readFileSync(source.path, 'utf8')));
  } catch {
    return null;
  }
}

/** Every prerequisite of a manager restore, read-only. */
async function prerequisites(
  services: FleetRestoreServices,
  context: StateContext
): Promise<Check[]> {
  const fleet = definition(services);
  const reached = connection(services.env, services.home);
  const checks: Check[] = [
    check('restore:configuration', fleet !== null, [
      'The project’s fleet.json is found and valid.',
      'No valid fleet.json was found.',
      'Run this from the project that holds your fleet.json, after git clone and npm ci.',
    ]),
    check('restore:bucket', reached.bucket !== null, [
      'The bucket is named, with credentials for it.',
      'No bucket is configured.',
      'Name it under "state" in fleet.json and pass DEVFLEET_BUCKET_ACCESS_KEY_ID and DEVFLEET_BUCKET_SECRET_ACCESS_KEY.',
    ]),
  ];
  if (reached.bucket) {
    const stands = await standing(context);
    checks.push(
      check(
        'restore:state',
        stands === 'bucket-ahead' || stands === 'in-sync',
        [
          'The bucket answers and holds the fleet state.',
          `The fleet state cannot be restored from the bucket: it stands "${stands}".`,
          'See the state:replica remedy of devfleet fleet-state; a corrupt replica is restored with --restore --timestamp.',
        ]
      )
    );
  }
  if (fleet) {
    const host = managerHost(fleet.manager.os);
    const name = await host.localHostName(services.run);
    checks.push(
      check('restore:host-name', name === fleet.manager.id, [
        `This machine’s local host name is the manager’s id (${fleet.manager.id}).`,
        `This machine’s local host name is not the manager’s id (${fleet.manager.id}).`,
        host.platform === 'macOS'
          ? `Set it: sudo scutil --set LocalHostName ${fleet.manager.id}`
          : `Set it: sudo hostnamectl set-hostname ${fleet.manager.id}`,
      ])
    );
  }
  const git = await services.run(['git', '--version']);
  checks.push(
    check('restore:git', git.ok, [
      'Git is installed.',
      'Git is not installed.',
      'Install Git; fleet-sync installs everything else.',
    ])
  );
  const tailscale = await services.run(['tailscale', 'status', '--json']);
  checks.push(
    check(
      'restore:tailscale',
      tailscale.ok && /"BackendState":\s*"Running"/.test(tailscale.stdout),
      [
        'This machine is signed in to the tailnet.',
        'This machine is not signed in to the tailnet.',
        'Sign in to Tailscale and approve the device: that is a person’s.',
        'warn',
      ]
    )
  );
  const docker = await services.run(['docker', 'version']);
  checks.push(
    check('restore:container-engine', docker.ok, [
      'The container engine answers.',
      'The container engine does not answer.',
      'Install and start Docker Desktop; the proxy and the hub run in it.',
      'warn',
    ])
  );
  return checks;
}

/** Brings a replacement manager back from the bucket: `--dry-run` verifies
 * every prerequisite and lists what would be restored, changing nothing.
 */
export async function fleetRestore(
  options: FleetRestoreOptions,
  services: FleetRestoreServices = {
    run: runCommand,
    env: process.env,
    home: homedir(),
    holder: managerHolder(process.env),
  }
): Promise<CommandOutcome> {
  const reached = connection(services.env, services.home);
  const context: StateContext = {
    root: stateRoot(services.env, services.home),
    bucket: reached.bucket,
    run: services.run,
    holder: services.holder ?? null,
  };
  const checks = await prerequisites(services, context);
  const ready = !checks.some((entry) => entry.status === 'fail');
  const done: string[] = [];
  if (ready && !options.dryRun) {
    const after = await pull(context);
    checks.push(
      check('restore:applied', after === 'in-sync', [
        'This machine holds the fleet state from the bucket. Next: devfleet fleet-sync (it may need --take-over while the old manager’s lease runs), then devfleet cliproxy install.',
        `The fleet state was not restored: it stands "${after}".`,
        'Run devfleet fleet-state for the remedy.',
      ])
    );
    done.push('Restored the fleet state from the bucket.');
  }
  const data = {
    ...makeReport('fleet-restore', [{ node: 'manager', checks }]),
    dryRun: options.dryRun === true,
    restores: RESTORES,
  };
  return {
    exitCode: reportExitCode(data, false),
    data,
    text: [
      ...done,
      renderReport(data),
      '',
      options.dryRun ? 'Would restore, in this order:' : 'Restored in order:',
      ...RESTORES.map(
        (entry, index) => `${index + 1}. ${entry.what}: ${entry.how}`
      ),
    ].join('\n'),
  };
}
