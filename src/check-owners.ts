/** Who repairs a check: a repair recipe (`repair`), or the reason only a
 * person can (`manual`). Every check ID dev-fleet reports matches one entry,
 * by its exact ID or by a prefix ending in `*` (`beszel:*`). The most
 * specific match wins. `login:*` is the sign-in recipe named after the rest
 * of an `auth:` check's ID.
 */
export interface CheckOwner {
  pattern: string;
  repair?: string;
  manual?: string;
}

const IDENTITY =
  'It needs a person: a sign-in, an approval or a choice only the operator can make.';
const EVIDENCE =
  'It reports how a command or a run went, not the state of a machine: repeat the command once its remedy is followed.';
const DECLARATION =
  'The fleet configuration (fleet.json) or the roster is wrong: only the operator edits them.';
const HARDWARE =
  'It is a property of the hardware, the firmware or the operating system release, which no command changes.';

const PARKING =
  'Whether a worker runs is the operator’s choice: park it with fleet-node-park or resume it with fleet-node-resume.';

export const CHECK_OWNERS: CheckOwner[] = [
  // Toolchain and workstation: automatic.
  { pattern: 'tool:*', repair: 'workspace' },
  { pattern: 'tool:docker-*', repair: 'docker' },
  { pattern: 'tool:github-auth*', repair: 'login:github' },
  { pattern: 'dependencies', repair: 'workspace' },
  { pattern: 'auth:toolchain', repair: 'workspace' },
  { pattern: 'workstation:*', repair: 'workstation' },
  { pattern: 'auth:*', repair: 'login:*' },
  { pattern: 'auth:vscode', manual: IDENTITY },
  { pattern: 'auth:workstation', manual: IDENTITY },
  { pattern: 't3:settings', repair: 't3' },
  { pattern: 't3:api', repair: 't3' },
  // The checks that fail when a machine breaks.
  { pattern: 'worker:service-recovery', repair: 'recovery' },
  { pattern: 'worker:capacity', repair: 'disk' },
  { pattern: 'worker:capacity:*', repair: 'disk' },
  { pattern: 'beszel:agent', repair: 'monitoring' },
  { pattern: 'beszel:service', repair: 'monitoring' },
  { pattern: 'beszel:installation', repair: 'monitoring' },
  { pattern: 'beszel:protocol', repair: 'monitoring' },
  { pattern: 'tailscale:configuration', repair: 'network' },
  { pattern: 'tailscale:online', repair: 'network' },
  { pattern: 'tailscale:reachability', repair: 'network' },
  { pattern: 'state:replica', repair: 'state' },
  { pattern: 'state:*', repair: 'state' },
  // What only a person can do.
  {
    pattern: 'beszel:*',
    manual:
      'The monitoring hub and its accounts are converged by fleet-sync on the manager; follow the remedy, then run fleet-sync.',
  },
  {
    pattern: 'tailscale:*',
    manual:
      'Signing a machine in to the tailnet and approving it is a person’s; the daemon itself is repaired by the network recipe.',
  },
  {
    pattern: 'state:bucket',
    manual:
      'The bucket and its credentials are the operator’s: name them in fleet.json and pass the credentials.',
  },
  { pattern: 'state:definition', manual: DECLARATION },
  {
    pattern: 'worker:*',
    manual:
      'Re-converge the worker with fleet-sync: it applies the whole worker policy at the approved revision.',
  },
  { pattern: 'worker:power-loss-recovery', manual: HARDWARE },
  {
    pattern: 'worker:account',
    manual:
      'fleet-sync creates the declared account over a root login; when it cannot, the account is created by the operator on the machine, or declared in fleet.json.',
  },
  {
    pattern: 'worker:reboot',
    manual:
      'A reboot ends running agent turns, so it waits for them: rerun fleet-sync --maintenance-reboot once they end, or with --force.',
  },
  {
    pattern: 'tailscale:enrolment-key',
    manual:
      'The tailnet-admin credential and the tag it may use are the operator’s, kept in the secrets provider and the control plane.',
  },
  {
    pattern: 'tailscale:key-expiry-policy',
    manual:
      'The tailnet-admin credential and the tag it may use are the operator’s, kept in the secrets provider and the control plane.',
  },
  {
    pattern: 'tailscale:device',
    manual:
      'Removing a device needs the tailnet-admin credential and a declared control plane, both the operator’s; without them a person removes it in the admin console.',
  },
  {
    pattern: 'tailscale:leftover',
    manual:
      'Whether a device tagged as a worker belongs to the fleet is the operator’s choice: declare it, or remove it from the tailnet.',
  },
  // Whether a worker runs is the operator's choice (fleet-node-park).
  { pattern: 'worker:idle', manual: PARKING },
  { pattern: 'worker:park*', manual: PARKING },
  { pattern: 'worker:auto-park', manual: PARKING },
  { pattern: 'worker:github-principal', manual: IDENTITY },
  { pattern: 'worker:vault-renewal', manual: IDENTITY },
  {
    pattern: 'manager:*',
    manual:
      'The manager converges itself in fleet-sync; what needs an administrator is granted once with ansible-playbook -e user=$(id -un) -K ansible/macos/manager-privilege.yml.',
  },
  { pattern: 'manager:identity', manual: DECLARATION },
  {
    pattern: 'manager:docker',
    manual:
      'Docker Desktop is installed and updated by a person; no playbook installs it.',
  },
  { pattern: 'macos:*', manual: HARDWARE },
  { pattern: 'ubuntu:release', manual: HARDWARE },
  {
    pattern: 'ubuntu:*',
    manual:
      'Re-converge the worker with fleet-sync: it applies the Ubuntu baseline.',
  },
  { pattern: 'platform:*', manual: HARDWARE },
  {
    pattern: 'ssh:*',
    manual:
      'SSH trust (host keys, keys in the agent, the alias) is set up by a person once per machine; dev-fleet never accepts a host key for you.',
  },
  { pattern: 'login:*', manual: IDENTITY },
  { pattern: 'provider:*', manual: IDENTITY },
  {
    pattern: 'agent:*',
    manual:
      'Re-converge the machine with fleet-sync; an agent that needs a sign-in is a person’s.',
  },
  {
    pattern: 't3:*',
    manual:
      'A worker’s first T3 pairing and its private route are approved by a person; a replaced worker is paired by fleet-node-replace or the next fleet-sync, and fleet-sync applies the rest.',
  },
  { pattern: 'vscode:*', manual: IDENTITY },
  {
    pattern: 'git:*',
    manual:
      'Uncommitted or unpushed work belongs to a person; dev-fleet never resets a checkout.',
  },
  {
    pattern: 'git:configuration',
    manual:
      'fleet-sync writes the Git identity and credential helper with ansible/github/git.yml; run it from the manager.',
  },
  {
    pattern: 'github:*',
    manual:
      'fleet-sync signs every node in to GitHub from the stored github-token (a worker retries every ten minutes); a token that is missing, expired or short of a scope or organisation needs a person to issue a new one.',
  },
  {
    pattern: 'github:git-credential',
    manual:
      'fleet-sync writes the GitHub credential helper with ansible/github/git.yml when the git block is declared; run it from the manager.',
  },
  { pattern: 'github:rate-limit', manual: EVIDENCE },
  { pattern: 'github:workflow', manual: EVIDENCE },
  { pattern: 'fleet:*', manual: DECLARATION },
  { pattern: 'definition:*', manual: DECLARATION },
  { pattern: 'enrollment:*', manual: DECLARATION },
  { pattern: 'notify:*', manual: DECLARATION },
  {
    pattern: 'proxy:*',
    manual:
      'The CLI proxy is installed with devfleet cliproxy install and its accounts are signed in by a person.',
  },
  {
    pattern: 'accounts:roster-current',
    manual:
      'The roster reaches every node with devfleet fleet-sync --only accounts, run from the manager.',
  },
  { pattern: 'accounts:native-login', manual: IDENTITY },
  { pattern: 'accounts:verification', manual: EVIDENCE },
  { pattern: 'configuration:*', manual: EVIDENCE },
  { pattern: 'source:*', manual: EVIDENCE },
  { pattern: 'bootstrap:*', manual: EVIDENCE },
  { pattern: 'rollout:*', manual: EVIDENCE },
  { pattern: 'repair:*', manual: EVIDENCE },
  // A roster computer's checkout compared with the manager's.
  {
    pattern: 'revision',
    manual:
      'The checkout of that computer differs from the manager’s: reconcile its branch, or converge it with fleet-sync; dev-fleet never resets a working tree.',
  },
  {
    pattern: 'sync:*',
    manual:
      'The checkout of that computer differs from the manager’s: reconcile its lockfiles and pins, or converge it with fleet-sync; dev-fleet never resets a working tree.',
  },
  {
    pattern: 'restore:*',
    manual:
      'fleet-restore rebuilds a replacement manager from the bucket; what it needs first (the project’s fleet.json, the bucket’s credentials, Git, Docker Desktop, a tailnet sign-in) is the operator’s: follow the remedy, then run fleet-restore again.',
  },
  {
    pattern: 'watch:*',
    manual:
      'The heartbeat is kept in the bucket fleet.json names: name it, or restore access to it, then run fleet-watch again.',
  },
];

const matches = (pattern: string, id: string): boolean =>
  pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern;

/** The entry that owns a check, or null for an ID nobody registered. */
export function checkOwner(id: string): CheckOwner | null {
  return (
    CHECK_OWNERS.filter((owner) => matches(owner.pattern, id)).sort(
      (a, b) => b.pattern.length - a.pattern.length
    )[0] ?? null
  );
}
