import type { Release } from './program';

const SAFETY = [
  'No arguments prints help, including on a TTY. --json returns this document. The menu requires --interactive; --json and --non-interactive never prompt.',
  'Diagnostics, onboarding instructions, schema, catalogs, scripts and repair previews are read-only.',
  'fleet-sync, fleet-node-sync, t3-apply and t3-cleanup apply by invocation; --dry-run previews. t3-apply --import ID explicitly adopts ownership. --json never implies a dry run. fleet-node-add and fleet-repair require --apply --yes.',
  'fleet-state alone is read-only; --init, --import, --push and --restore each act on invocation. Bucket credentials come from DEVFLEET_BUCKET_ACCESS_KEY_ID and DEVFLEET_BUCKET_SECRET_ACCESS_KEY or a terminal prompt, never from arguments.',
  'Do not copy credentials, forward SSH agents, bypass host keys, provision infrastructure or execute unreviewed remedies.',
  'A healthy manager does not prove another machine can connect to it. Run fleet-status from each intended manager.',
  'fleet-repair executes only allowlisted owner actions, then reruns diagnostics. Native logins, host trust and resource permissions remain explicit operator steps. Pass the reviewed planHash as --plan-hash to reject a changed plan.',
  'Shared provider keys are fetched through each machine’s existing Vault authorization by workstation tooling. Never copy machine-local login caches.',
  'Use exact npm versions for automation. The application never self-updates.',
];

const EXAMPLES = [
  'devfleet fleet-node-sync',
  'devfleet fleet-status',
  'devfleet fleet-state --json',
  'devfleet t3-status',
  'devfleet fleet-status --local --workspace /path/to/personal --json',
  'devfleet fleet-status --json --strict --timeout 120000',
  'devfleet fleet-status --tailnet --json',
  'devfleet fleet-status --workers --json',
  'devfleet fleet-node-add --id dev-linux --ssh dev-linux --path /home/dev/workspace --require github,t3,toolchain --json',
  'devfleet fleet-node-add --id dev-linux --ssh dev-linux --path /home/dev/workspace --apply --yes --json',
  'devfleet fleet-status --node dev-linux --json',
  'devfleet fleet-repair --list --json',
  'devfleet fleet-repair --json',
  'devfleet fleet-repair --local --repair workspace --json',
  'devfleet fleet-repair --local --repair workspace --plan-hash <reviewed-sha256> --apply --yes --json',
];

/** For an agent working in another project, which is every project that uses
 * dev-fleet: a change to dev-fleet is asked for, never made in place.
 */
function support(release: Release) {
  return {
    issues: release.issues ?? null,
    report:
      'A defect in dev-fleet, or something it cannot do yet, is raised as an issue in the dev-fleet repository: one issue per bug or feature request, after searching the open ones. From any other project that is the only way to change dev-fleet. Tell the operator what is blocked and link the issue.',
    never:
      'Do not edit the installed package, a checkout fleet-sync owns or a file dev-fleet manages on a machine: the next install or fleet-sync replaces each of them. Do not clone dev-fleet to patch it, vendor a modified copy, or hide the defect behind a workaround in the project that holds fleet.json.',
    include:
      'devfleet --version, the command and its flags, the error code or the failing check IDs from --json, what happened and what was expected.',
    withhold:
      'The issue tracker is public. Leave out credentials, the fleet configuration, hostnames, accounts, domains, tailnet names, paths under a home directory and raw subprocess output.',
  };
}

export function agentGuide(release: Release) {
  return {
    version: 1,
    name: 'dev-fleet',
    release: release.version,
    releasedAt: release.releasedAt,
    invocation: 'devfleet <command> --json --non-interactive',
    discovery: 'devfleet commands --json',
    defaultCommand: 'help',
    help: 'devfleet <command> --help',
    interactive:
      'devfleet --interactive (explicit opt-in; TTY required, disabled in CI)',
    groups: {
      'fleet-*':
        'Developer computers: fleet-status, fleet-discover, fleet-sync, fleet-state, fleet-node-sync, fleet-repair, fleet-nodes, fleet-node-add',
      't3-*': 'Declared T3 provider instances: t3-status, t3-apply, t3-cleanup',
      cliproxy: 'The CLI proxy service on the manager; arguments are forwarded',
    },
    configuration: {
      workspace:
        'The published package itself. Run from a checkout (development): --workspace PATH, PERSONAL_WORKSPACE, then the dev-fleet checkout the command is started in',
      roster:
        '--config PATH, PERSONAL_FLEET_CONFIG, closest ancestor .fleet.local.json, then the roster in the fleet state',
      definition:
        'DEVFLEET_CONFIG, then the closest fleet.json in the working directory or above it (the operator’s project), then the configuration fleet-sync last applied from the fleet state (the devfleet CLI on the manager), then the copy fleet-sync installed at ~/.config/dev-fleet/fleet.json',
      state:
        'DEVFLEET_STATE or ~/.local/share/dev-fleet/state: a local copy of the roster, the approved revision and the configuration last applied. The bucket named under "state" in the fleet configuration is the source of truth; its credentials are passed in DEVFLEET_BUCKET_ACCESS_KEY_ID and DEVFLEET_BUCKET_SECRET_ACCESS_KEY, or saved by devfleet fleet-state --init in ~/.config/dev-fleet/bucket.json for unattended runs. devfleet fleet-state --json compares the copies',
      revision:
        'The commit the published package names (devfleet --version). fleet-sync converges every machine to it; --revision SHA selects another',
    },
    output: {
      stdout:
        'Public diagnostics emit one versioned JSON document with --json. cliproxy retains its owner output contract; native agent launch commands stream native output.',
      exitCodes: {
        '0': 'Success or preview',
        '1': 'Failed check or operation; strict also rejects warnings/skips',
        '2': 'Invalid usage or configuration',
        '130': 'Cancelled',
      },
      errors:
        '{version:1,ok:false,code,error}; raw subprocess output and exception details are withheld',
      reports:
        '{version:1,command,ok,generatedAt,nodes:[{node,checks:[{id,status,summary,remedy?}]}],summary,coverage}',
      statuses: ['pass', 'warn', 'fail', 'skip'],
      coverage:
        'Default fleet-status tests the manager and all configured nodes. --local tests only this manager; --tailnet and --workers cover Tailscale computers. A missing roster fails explicitly. T3/VS Code end-to-end checks remain manual.',
    },
    safety: SAFETY,
    support: support(release),
    fleetSync: {
      command: 'devfleet fleet-sync',
      preview: 'devfleet fleet-sync --dry-run --json',
      approval: 'Applies on invocation without a prompt; --dry-run previews',
      scope:
        'Whole enrolled Ubuntu fleet over verified SSH; --node filters diagnostics/rollout',
      state:
        'The approved and applied revision are kept in the fleet state and uploaded to its bucket after every run; the report carries the state:replica check',
      readiness:
        'Full Ubuntu acceptance is incomplete and fails closed; do not override it or claim deployment success.',
    },
    reconciliation: {
      plan: 'devfleet t3-apply --dry-run --json',
      apply: 'devfleet t3-apply --plan-hash HASH',
      cleanup: 'devfleet t3-cleanup --dry-run',
      import: 'devfleet t3-apply --import ID',
      ownership:
        'Only declared or explicitly imported T3 instances. Pairing, credentials, threads and unrelated settings are preserved.',
      concurrency:
        'Exclusive personal lock with optimistic external T3 file updates; avoid concurrent Settings edits.',
    },
    examples: EXAMPLES,
  };
}
