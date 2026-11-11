import type { Release } from './program';

const SAFETY = [
  'No arguments prints help, including on a TTY. --json returns this document. The menu requires --interactive; --json and --non-interactive never prompt.',
  'Diagnostics, onboarding instructions, schema, catalogs, scripts and repair previews are read-only.',
  'fleet-sync, fleet-node-sync, t3-apply and t3-cleanup apply by invocation; --dry-run previews. t3-apply --import ID explicitly adopts ownership. --json never implies a dry run. fleet-node-add and fleet-repair require --apply --yes.',
  'Do not copy credentials, forward SSH agents, bypass host keys, provision infrastructure or execute unreviewed remedies.',
  'A healthy manager does not prove another machine can connect to it. Run fleet-status from each intended manager.',
  'fleet-repair executes only allowlisted owner actions, then reruns diagnostics. Native logins, host trust and resource permissions remain explicit operator steps. Pass the reviewed planHash as --plan-hash to reject a changed plan.',
  'Shared provider keys are fetched through each machine’s existing Vault authorization by workstation tooling. Never copy machine-local login caches.',
  'Use exact npm versions for automation. The application never self-updates.',
];

const EXAMPLES = [
  'devfleet fleet-node-sync',
  'devfleet fleet-status',
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
        'Developer computers: fleet-status, fleet-discover, fleet-sync, fleet-node-sync, fleet-repair, fleet-nodes, fleet-node-add',
      't3-*': 'Declared T3 provider instances: t3-status, t3-apply, t3-cleanup',
      cliproxy: 'The CLI proxy service on the manager; arguments are forwarded',
    },
    configuration: {
      workspace:
        '--workspace PATH, PERSONAL_WORKSPACE, closest ancestor mise.toml, then current directory',
      roster:
        '--config PATH, PERSONAL_FLEET_CONFIG, closest ancestor .fleet.local.json, then ~/.config/personal/fleet.json',
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
    fleetSync: {
      command: 'devfleet fleet-sync',
      preview: 'devfleet fleet-sync --dry-run --json',
      approval: 'Applies on invocation without a prompt; --dry-run previews',
      scope:
        'Whole enrolled Ubuntu fleet over verified SSH; --node filters diagnostics/rollout',
      state: '~/.local/share/personal/fleet/manager/enrollment.json',
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
