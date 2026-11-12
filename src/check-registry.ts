import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import agents from '../agents/registry.json';
import ubuntu from '../ansible/ubuntu/policy.json';
import { NATIVE_AGENTS } from './agents/native-verify';
import { CHECK_OWNERS } from './check-owners';
import { CAPABILITIES } from './config';
import { FINGERPRINT_FILES } from './input-hashes';
import { HEALTH_CHECK_IDS } from './machine-health';
import { NOTIFY_TARGETS } from './notify';
import { packagePins, ubuntuRelease } from './platform/ubuntu-release';
import { AUTOMATED_REPAIRS } from './repair-catalog';
import { checkRepair } from './repair-plan';
import { PROXY_ROUTED, SERVICE_IDS } from './service-auth';
import { DOCUMENTS } from './state/store';

/** schema/check-ids.json is generated from this module:
 * `bun src/check-registry.ts > schema/check-ids.json`.
 * features/rules/contracts.feature fails when the committed file differs.
 */
export const PACKAGE_ROOT = resolve(import.meta.dir, '..');

// ── Where the code writes a check ID ─────────────────────────────────────

/** The `id` of a check (`id: 'ssh:auth'`, `id: given ?? 'ssh:auth'`), a
 * variable named `id` a check takes (`const id = 'ssh:auth'`), or the first
 * argument of a function that builds one (`notApplicable('worker:docker-run',
 * …)`, `attempt('ssh:auth', …)`). A name filled in at run time is a `*`.
 */
const LITERAL = String.raw`'([^'\n]*)'|"([^"\n]*)"|\x60([^\x60\n]*)\x60`;
const SITE = new RegExp(
  String.raw`(\bid: (?:[^,\n]*\?\? )?|\b(?:const|let) id = |\b[A-Za-z_$][\w$]*\(\s*)(?:${LITERAL})`,
  'g'
);
/** A shell script prints a check as JSON: `{"id":"bootstrap:%s",…}`. */
const SHELL_SITE = /()"id":"([^"\n]*)"()()/g;
const NAMESPACED = /^[a-z0-9-]+(?::[A-Za-z0-9.*_-]+)+$/;
/** Strings with a colon that name something other than a check. */
const NOT_CHECKS = new Set(['node', 'personal']);

/** Where checks are made. The owners of the checks, the repair recipes and
 * this registry name them; they make none. */
const SOURCES = ['src', 'bootstrap', 'agents'];
const NOT_MADE_HERE = new Set([
  'src/check-owners.ts',
  'src/repair-catalog.ts',
  'src/check-registry.ts',
]);

function sources(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|sh)$/.test(entry.name))
        found.push(relative(root, path).split('\\').join('/'));
    }
  };
  for (const directory of SOURCES) walk(join(root, directory));
  return found.filter((path) => !NOT_MADE_HERE.has(path)).sort();
}

/** A check without a namespace is one an owner names exactly. */
const unnamespaced = (): Set<string> =>
  new Set(
    CHECK_OWNERS.map((owner) => owner.pattern).filter(
      (pattern) => !/[:*]/.test(pattern)
    )
  );

/** The check IDs one source writes, as written: a `*` for a name filled in
 * at run time. */
export function checkIdsIn(text: string, shell = false): string[] {
  const plain = unnamespaced();
  const found = new Set<string>();
  for (const match of text.matchAll(shell ? SHELL_SITE : SITE)) {
    const id = (match[2] ?? match[3] ?? match[4]!).replace(
      /\$\{[^}]*\}+|%s/g,
      '*'
    );
    if (plain.has(id)) found.add(id);
    else if (NAMESPACED.test(id) && !NOT_CHECKS.has(id.split(':')[0]!))
      found.add(id);
  }
  return [...found].sort();
}

/** Every check ID the code writes. */
export function writtenCheckIds(root = PACKAGE_ROOT): string[] {
  return [
    ...new Set(
      sources(root).flatMap((path) =>
        checkIdsIn(readFileSync(join(root, path), 'utf8'), path.endsWith('.sh'))
      )
    ),
  ].sort();
}

// ── Names the code fills in from a list it holds ─────────────────────────

const BOOTSTRAP = 'bootstrap/fleet-remote-bootstrap.sh';

/** The phases of the remote bootstrap, each reported as `bootstrap:<phase>`
 * when the bootstrap stops in it. */
function bootstrapPhases(root: string): string[] {
  return [
    ...readFileSync(join(root, BOOTSTRAP), 'utf8').matchAll(
      /^phase='?([a-z0-9-]+)'?$/gm
    ),
  ].map((match) => match[1]!);
}

const pinnedPackages = (): string[] => [
  ...new Set([
    ...ubuntu.releases.flatMap((entry) =>
      Object.keys(packagePins(ubuntuRelease(entry.release)))
    ),
    'tailscale',
  ]),
];

/** A `*` the code fills in from a list it holds is that list. A `*` filled
 * in from the fleet configuration, a machine or a tool's own output (a node,
 * a tool, an account) stays a `*`. */
function expansions(root: string): Record<string, string[]> {
  const providers = Object.keys(agents.proxy.routes);
  const natives = NATIVE_AGENTS.map((agent) => agent.name);
  return {
    'auth:*': [...CAPABILITIES, ...SERVICE_IDS, ...Object.keys(PROXY_ROUTED)],
    'agent:*': Object.keys(agents.tools),
    'agent:*:version': natives,
    'agent:*:session': natives,
    'bootstrap:*': bootstrapPhases(root),
    'notify:*': Object.keys(NOTIFY_TARGETS),
    'provider:*:authentication': providers,
    'provider:*:inference': providers,
    'repair:*': AUTOMATED_REPAIRS,
    'state:*': [...DOCUMENTS],
    'sync:*': FINGERPRINT_FILES,
    'worker:capacity:*': HEALTH_CHECK_IDS,
    'worker:package:*': pinnedPackages(),
    'worker:service:*': ubuntu.alwaysOnServices,
  };
}

/** Every check ID the code reports, with the `*` it was written with when
 * the code fills that `*` in from a list. */
export function reportedCheckIds(
  root = PACKAGE_ROOT
): { id: string; from?: string }[] {
  const lists = expansions(root);
  const ids = new Map<string, string | undefined>();
  for (const written of writtenCheckIds(root)) {
    const names = lists[written];
    if (!names) {
      if (!ids.has(written)) ids.set(written, undefined);
      continue;
    }
    for (const name of names) {
      const id = written.replace('*', name);
      if (!ids.has(id)) ids.set(id, written);
    }
  }
  return [...ids]
    .map(([id, from]) => (from ? { id, from } : { id }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ── What each check means, and whether it can block readiness ───────────

/** What a passing check means. A `*` entry is the meaning of every ID filled
 * in from it that has none of its own. */
export const CHECK_MEANINGS: Record<string, string> = {
  'accounts:native-login':
    'This machine holds no provider login of its own outside the proxy.',
  'accounts:roster-current':
    "This machine offers exactly the accounts of the proxy's current account roster.",
  'accounts:verification':
    'The provider accounts this machine offers were verified; fails when verification could not run.',
  'agent:*':
    'A coding agent CLI is installed at its pinned version on this machine.',
  'agent:*:*:*':
    'A coding agent launches with its fleet profile on this machine.',
  'agent:*:account-*:session':
    'An agent instance of one proxy account is signed in and usable on this machine.',
  'agent:*:removed-*:session':
    'This machine offers no agent instance for an account the proxy no longer holds.',
  'agent:*:session':
    'The shared account of a coding agent is signed in and usable.',
  'agent:*:version': 'A coding agent runs the version the fleet pins.',
  'agent:profiles': "The fleet's agent profiles are written on this machine.",
  'agent:service-environment':
    'The environment agent services start with is complete.',
  'agent:verification':
    'Every coding agent was verified; fails when verification could not run.',
  'auth:*': 'A required login or capability works in this process context.',
  'auth:copilot':
    "Copilot CLI uses the node's GitHub sign-in with a token it accepts.",
  'auth:github': 'gh answers auth status in this context.',
  'auth:toolchain':
    'The pinned toolchain, dependencies and Docker could be checked.',
  'auth:vault': 'This machine has its own Vault session.',
  'auth:vault-isolation':
    "A worker reads its Vault token from a document of its own, not from the fleet's shared one.",
  'auth:worker-token':
    "A worker has a Vault token of its own that only it and the manager can read, or a retired worker's token is revoked.",
  'beszel:access': 'The monitoring dashboard answers privately.',
  'beszel:api':
    "The monitoring hub's API answers this account for this machine.",
  'beszel:backup': "The monitoring hub's data is backed up.",
  'beszel:connection': 'The monitoring hub reports this machine connected.',
  'beszel:disk': "The monitoring hub's disk use could be verified.",
  'beszel:enrollment': 'This machine is enrolled in the monitoring hub.',
  'beszel:freshness':
    'The monitoring hub received a sample from this machine within 180 seconds.',
  'beszel:hub': 'The monitoring hub runs on the manager.',
  'beszel:hub-connection': 'The monitoring agent reaches the hub.',
  'beszel:installation':
    'The monitoring agent is installed at its pinned version.',
  'beszel:leftover':
    'The monitoring hub watches no system that matches no declared worker.',
  'beszel:lock': "Monitoring changes could take the machine's operation lock.",
  'beszel:operation': 'The monitoring operation completed.',
  'beszel:protocol':
    "The machine's monitoring evidence is a valid fleet document.",
  'beszel:public-endpoint': 'The public monitoring dashboard answers.',
  'beszel:public-viewer': 'The public read-only viewer account works.',
  'beszel:registration':
    'The monitoring hub holds exactly one system record for this machine.',
  'beszel:service': 'The monitoring agent service runs.',
  'beszel:system':
    "The monitoring hub's system for a replaced worker watches the new machine, or a retired worker's system is gone.",
  'beszel:version': 'The monitoring hub runs the pinned Beszel release.',
  'bootstrap:attached':
    "The manager followed this machine's running operation of the same revision and reports its result.",
  'bootstrap:bootstrap':
    'The worker is a supported Ubuntu release and architecture, not a container or WSL2, reached as a non-root account, and its fleet state directory is safe.',
  'bootstrap:cleanup':
    'Revision checkouts beyond the current, the applied and the two most recent were removed.',
  'bootstrap:configuration':
    'The node converged at the revision: its configuration, services and evidence.',
  'bootstrap:configuration-install':
    'The fleet configuration was written on the worker under its operation lock.',
  'bootstrap:exit': 'The remote bootstrap exited without failure.',
  'bootstrap:first-boot':
    "The machine's own first boot (cloud-init) has finished, or it has none.",
  'bootstrap:lock': "The bootstrap holds the worker's fleet operation lock.",
  'bootstrap:prerequisites':
    'The packages the bootstrap needs are installed; an interrupted package run was finished first.',
  'bootstrap:privilege':
    'The development account may use sudo without a password.',
  'bootstrap:protocol':
    'The remote bootstrap answered with a valid fleet document.',
  'bootstrap:resources':
    'The home file system has the space and inodes the bootstrap needs.',
  'bootstrap:source-transfer':
    'The source bundle arrived with the digest the manager sent.',
  'bootstrap:source-verification':
    'The fleet-owned checkout holds exactly the revision, with no change fleet-sync did not make.',
  'bootstrap:tailnet-key':
    'The single-use tailnet key was handed to the worker in a root-only file.',
  'bootstrap:toolchain': 'The pinned toolchain converged.',
  'configuration:apply':
    "The node's configuration (agent profiles, launcher) was applied.",
  'configuration:operation': 'The remote configuration operation completed.',
  'definition:inventory':
    'Ansible reads the inventory the fleet definition describes.',
  'definition:playbooks':
    'Every playbook passes ansible-playbook --syntax-check.',
  'definition:schema': 'fleet.json follows every rule of the fleet definition.',
  dependencies:
    "The checkout's dependencies are installed as its lockfile and inputs declare.",
  'enrollment:connection':
    'The manager has an enrolled connection to this worker.',
  'enrollment:record': 'A worker whose record disappeared was retired.',
  'fleet:enrollment:*':
    'A declared worker has a verified SSH and checkout registration.',
  'fleet:probe': 'The remote probe could be prepared and completed.',
  'fleet:registration': 'The machine is registered in the roster.',
  'fleet:roster': 'A fleet roster is configured.',
  'git:clean': 'The checkout has no uncommitted changes.',
  'git:configuration':
    "The declared Git identity and the GitHub credential helper are written in the node's global Git configuration.",
  'github:expiry':
    'The GitHub token does not expire within the warning window.',
  'github:git-credential': 'git asks gh for its GitHub credential.',
  'github:org-access':
    'Single sign-on has authorised the GitHub token for each declared organisation.',
  'github:permissions':
    'The GitHub token has every declared scope and can push to every declared repository.',
  'github:principal': 'The node is signed in to GitHub as its declared login.',
  'github:rate-limit': 'The GitHub rate limit left is above the warning floor.',
  'github:sync':
    'fleet-sync signed this node in to GitHub from the stored credential.',
  'github:token-current': 'The node uses the GitHub token the store holds now.',
  'github:workflow':
    'fleet-github-verify completed clone, branch, commit, push, pull request, checks and comment on the sandbox repository.',
  'manager:boot-recovery':
    'The manager comes back by itself after a power cut or reboot.',
  'manager:clock': 'The manager keeps its clock on network time.',
  'manager:container-watchdog':
    'No container on the manager was capped or restarted by the container watchdog within the last hour.',
  'manager:disk':
    "The manager's data volume has the free space the macOS policy asks for.",
  'manager:docker': 'The manager runs the pinned Docker Desktop.',
  'manager:identity': 'This machine is the declared fleet manager.',
  'manager:job-logs':
    "newsyslog keeps the logs of the manager's scheduled jobs under the size the macOS policy names.",
  'manager:playbook':
    'The manager playbook passed its check-mode run and was applied, or is unchanged since and its postconditions hold.',
  'manager:power': 'The manager never sleeps on AC power.',
  'manager:preflight':
    'fleet-sync could start on the manager; its summary names the reason when not.',
  'manager:release':
    'The manager runs at least the macOS release the macOS policy requires.',
  'manager:schedule':
    "The manager's schedule converged the fleet within two of its intervals.",
  'manager:updates': 'No macOS update is pending on the manager.',
  'manager:watch':
    'fleet-watch runs on the manager on a schedule, so the heartbeat reaches the bucket.',
  'notify:*': 'A notification target fleet.json names took the notification.',
  'notify:configured':
    'Every notification target fleet.json names has its address available as a secret.',
  'platform:environment':
    'The worker runs on a physical or virtual machine of its own, not in a container or WSL2.',
  'platform:machine-class':
    'The probe recorded the class of the worker (physical or virtual machine) before anything is installed; a virtual machine reports firmware power recovery and lid policy as not applicable.',
  'platform:unsupported': 'The machine runs a supported operating system.',
  'platform:worker-size':
    'The worker has at least the stated minimum memory, root filesystem and CPUs (sizing.minimumWorker in the Ubuntu policy), measured before anything is installed.',
  'provider:*:authentication': 'A proxy provider authenticates unattended.',
  'provider:*:inference':
    'A proxy provider answers a bounded inference round trip.',
  'provider:verification':
    'Every proxy provider was verified; fails when verification could not run.',
  'proxy:*': "A phase of the CLI proxy's reconciliation completed.",
  'proxy:account:*':
    'A provider has at least one usable account signed in on the CLI proxy.',
  'proxy:configuration': "The CLI proxy's configuration was reconciled.",
  'proxy:reachable-from': 'This machine reaches the CLI proxy, and how fast.',
  'repair:*': 'An automated repair completed.',
  'repair:inputs':
    'The checkout inputs are unchanged since the diagnostics a repair plan used.',
  'repair:operation': 'A repair could be prepared and completed.',
  'repair:recheck': 'Diagnostics completed again after a repair.',
  'repair:workspace': 'A complete checkout exists for repairs.',
  'restore:applied':
    'A replacement manager holds the fleet state from the bucket.',
  'restore:bucket':
    'The bucket is named in fleet.json, with credentials for it.',
  'restore:configuration': "The project's fleet.json is found and valid.",
  'restore:container-engine':
    'The container engine answers on the replacement manager.',
  'restore:git': 'Git is installed on the replacement manager.',
  'restore:host-name':
    'The replacement manager has the host name fleet.json gives the manager.',
  'restore:state': 'The bucket answers and holds the fleet state.',
  'restore:tailscale': 'The replacement manager is signed in to the tailnet.',
  revision: "The computer's checkout is at the manager's commit.",
  'rollout:evidence': "A worker's rollout produced verification evidence.",
  'rollout:next':
    'Names the command that converges a worker after it was replaced.',
  'rollout:node':
    'The fleet-sync of one worker that fleet-node-resume runs ended ready.',
  'rollout:operation': 'The remote rollout operation completed.',
  'rollout:prerequisites': "A worker met the rollout's prerequisites.",
  'rollout:promotion':
    'The canary proved the revision, so promotion to this worker went ahead.',
  'source:bootstrap':
    'The approved bootstrap source is available on the manager.',
  'ssh:agent': 'The SSH agent exposes at least one identity.',
  'ssh:auth': 'SSH key or agent authentication succeeded.',
  'ssh:disconnected': 'The SSH session was not lost while an operation ran.',
  'ssh:dns': 'The SSH host name resolved.',
  'ssh:fresh-session': 'A fresh, host-key-verified SSH session succeeded.',
  'ssh:host-key': "The worker's SSH host key is known and unchanged.",
  'ssh:missing': 'The local SSH client could be started.',
  'ssh:network': 'The SSH endpoint is reachable.',
  'ssh:probe': 'A remote probe over SSH succeeded.',
  'ssh:protocol': 'The remote answer is a supported fleet document.',
  'ssh:runtime':
    'The remote workspace and runtime exist for non-login SSH sessions.',
  'ssh:session': 'A noninteractive SSH session and probe succeeded.',
  'ssh:tailscale-check':
    'Tailscale SSH did not require interactive reauthentication.',
  'ssh:timeout': 'SSH and the remote probe finished within their deadline.',
  'state:*':
    'A document of the fleet state (definition, roster, enrollment) is stored.',
  'state:bucket': 'A bucket for the fleet state is configured and reachable.',
  'state:replica': "The bucket holds this manager's fleet state.",
  'state:retired': 'The fleet state records that a retired worker was retired.',
  'sync:*':
    "An input of the computer's checkout (a lockfile, a tool pin, a manifest) matches the manager's.",
  't3:api': 'The local T3 API answers.',
  't3:end-to-end': 'T3 relay and peer access, which need an operator test.',
  't3:link':
    "The manager's T3 link to a replaced or retired worker's old environment is gone.",
  't3:manager-endpoint':
    "The manager reaches the worker's private T3 endpoint.",
  't3:manager-origin': "The manager's T3 origin is configured.",
  't3:models':
    'T3 offers only the declared models for every account instance the fleet manages.',
  't3:paired-access': "The manager's T3 is linked to this worker.",
  't3:policy-loaded': 'The running T3 loaded the managed policy.',
  't3:policy-staged': 'The managed T3 policy is installed.',
  't3:prerequisites': 'The T3 baseline prerequisites are present.',
  't3:private-route': "T3's private HTTPS route is served.",
  't3:profile': 'The declared T3 settings are in place on this machine.',
  't3:provider-names': "T3 lists the fleet's provider names.",
  't3:providers': "T3's provider instances are the declared ones.",
  't3:running-version':
    'The running T3 server is the installed release; a restart the release needs waits for running agent turns.',
  't3:service': 'The pinned T3 app runs.',
  't3:settings': 'T3 settings are readable.',
  't3:updates': "T3's own updater is off, as the fleet's policy declares.",
  't3:version': 'This machine runs the T3 version the fleet pins.',
  'tailscale:configuration': 'Tailscale is configured as declared.',
  'tailscale:device':
    "A replaced or retired worker's old tailnet device was removed.",
  'tailscale:discovery': 'Tailscale computers could be discovered.',
  'tailscale:enrolled-identity':
    'The Tailscale identity matches the enrollment.',
  'tailscale:enrolment-key':
    "A worker that is not on the tailnet yet was handed a single-use, pre-authorised, tagged key minted by the fleet's control plane.",
  'tailscale:identity': "A machine's Tailscale identity is unambiguous.",
  'tailscale:key-expiry':
    "The machine's Tailscale node key does not expire, or not within the warning window.",
  'tailscale:key-expiry-policy':
    'The control plane disabled node-key expiry for an enrolled worker whose key had one.',
  'tailscale:leftover':
    "Every device on the tailnet that carries the fleet's worker tag is a declared worker (parked ones included) or a device the roster binds; warns, naming the device, for one that is not.",
  'tailscale:membership': 'A registered machine is in the visible tailnet.',
  'tailscale:online': 'Tailscale is online on this machine.',
  'tailscale:reachability': 'The machine is online in the tailnet.',
  'tool:*':
    'A pinned tool, or the global mise configuration (tool:global-mise-config), is as the revision declares.',
  'tool:docker-cli':
    'Not applicable on a worker whose containers feature is off: the Docker CLI is not one of its tools.',
  'ubuntu:baseline': 'The Ubuntu baseline policy is applied.',
  'ubuntu:boot-policy': 'The no-sleep and session boot policy is active.',
  'ubuntu:lid-policy':
    'Not applicable on a virtual machine, which has no lid; on a physical machine the lid policy is part of ubuntu:boot-policy.',
  'ubuntu:prerequisites': 'The Ubuntu prerequisites are installed.',
  'ubuntu:release': 'The worker runs the supported Ubuntu release.',
  'ubuntu:resource-safety':
    'The OOM killer, disk guard and resource caps are active.',
  'vscode:forwarding':
    'VS Code Remote-SSH forwarding, which needs an operator test.',
  'watch:heartbeat':
    "fleet-watch stored its heartbeat and each machine's health in the bucket.",
  'worker:account':
    "The declared worker account was created over a root login, with the manager's key and the fleet's sudo rule.",
  'worker:agent-sessions':
    'How many agent sessions this worker runs, and how many its memory policy supports at the estimated size of a session; warns when more run.',
  'worker:auto-park':
    'fleet-watch parked a worker idle longer than declared (only with parking.autoPark).',
  'worker:browser':
    'A headless browser starts on a worker whose tool profiles include web.',
  'worker:capacity': 'CPU, memory and disk evidence is available.',
  'worker:capacity:*':
    'A worker meets one capacity floor (load, memory, disk, inodes).',
  'worker:clock': 'The worker keeps its clock on network time.',
  'worker:clock-offset':
    "The worker's clock is within the offset the Ubuntu policy allows of the manager's.",
  'worker:credential-renewal': 'Worker credential renewal timer is active.',
  'worker:desired-source': 'The worker runs the declared revision.',
  'worker:docker-run':
    'A container starts and exits on a worker whose containers feature is on.',
  'worker:exposure':
    'Nothing listens on the worker beyond loopback and the tailnet but what the declared exposure policy allows, and the fleet firewall that closes the rest is loaded; not applicable without an address outside the tailnet.',
  'worker:features':
    'The worker has the features fleet.json declares, and nothing dev-fleet installed for a feature that is off (containers) remains.',
  'worker:git-identity':
    "The worker's global Git identity is the one fleet.json declares.",
  'worker:git-push-auth':
    'The worker can push to the declared repositories with the fleet credentials.',
  'worker:git-signing':
    'The worker signs commits as fleet.json declares, or leaves signing off.',
  'worker:github-sync':
    'The worker is signed in to GitHub from the stored credential as the declared login.',
  'worker:idle':
    "An active worker runs an agent turn, or has run one within fleet.json's parking.idleAfterHours; warns once it has been idle longer.",
  'worker:manifest':
    'A worker is made of what the declared pins and a fresh build of the same revision are made of.',
  'worker:package:*':
    'The pinned Ubuntu package is installed at or past its pin.',
  'worker:park-hook':
    'The stop or start command fleet.json declares under parking ran for the worker.',
  'worker:parked':
    'A worker parked on purpose: listed with the time since, not contacted and never the canary (not-applicable). As a command result, the worker was parked or resumed.',
  'worker:parked-online': 'A parked worker is not online on the tailnet.',
  'worker:power-loss-recovery': 'The worker powers on after AC loss.',
  'worker:proxy-authentication':
    'The worker authenticates to the shared proxy.',
  'worker:proxy-singleton':
    'The worker is a proxy client, not a second gateway.',
  'worker:public-reachability':
    "From the manager, the worker's SSH, T3 and monitoring ports accept no connection on its public address; optional, and not applicable when Tailscale knows no public address for it.",
  'worker:readiness': 'The worker readiness checks could run.',
  'worker:reboot':
    'The worker was rebooted while it ran no agent turn (after its first converge, or for maintenance), answered again and was converged once more.',
  'worker:reboot-pending': 'The worker needs no reboot to finish an update.',
  'worker:service:*':
    'A service every worker runs is active, enabled for boot and restarts unconditionally.',
  'worker:service-recovery': 'Worker services recover after failure.',
  'worker:sudo': 'Designated worker user has noninteractive sudo.',
  'worker:t3-health':
    'T3 local API answers with its environment identity within 10 seconds.',
  'worker:t3-recovery':
    "The worker's T3 service is active, enabled for boot and restarts after a failure.",
  'worker:ubuntu': 'Required Ubuntu release and architecture.',
  'worker:vault-renewal': 'The worker renews its Vault identity unattended.',
  'workstation:configuration': 'The devfleet launcher is installed and linked.',
  'workstation:installation': 'The devfleet launcher could be installed.',
  // An agent CLI that signs in through the proxy has no login to check.
  ...Object.fromEntries(
    Object.keys(PROXY_ROUTED).map((id) => [
      `auth:${id}`,
      `Not applicable: ${id} has no sign-in of its own on this machine; its summary names the check that proves its access instead.`,
    ])
  ),
};

/** Checks that never block readiness: the code reports them only as a
 * warning, or with `required: false`. Every other check is required: its
 * failure blocks readiness unless the run says the check is out of scope. */
export const ADVISORY_CHECKS = [
  'beszel:leftover',
  'github:rate-limit',
  'manager:docker',
  'manager:job-logs',
  'manager:updates',
  't3:models',
  't3:updates',
  'tailscale:device',
  'tailscale:leftover',
  'worker:auto-park',
  'worker:idle',
  'worker:parked-online',
  'worker:public-reachability',
  ...Object.keys(PROXY_ROUTED).map((id) => `auth:${id}`),
];

// ── The registry ─────────────────────────────────────────────────────────

export type Severity = 'required' | 'advisory';
export type Repair = ReturnType<typeof checkRepair>;
export interface RegisteredCheck {
  id: string;
  meaning: string;
  severity: Severity;
  repair: Repair;
}

export interface CheckRegistry {
  checks: RegisteredCheck[];
  /** IDs the code reports that have no meaning. */
  missing: string[];
  /** Meanings no reported ID uses. */
  unused: string[];
}

export function checkRegistry(root = PACKAGE_ROOT): CheckRegistry {
  const used = new Set<string>();
  const missing: string[] = [];
  const checks = reportedCheckIds(root).map(({ id, from }): RegisteredCheck => {
    const key =
      id in CHECK_MEANINGS ? id : from && from in CHECK_MEANINGS ? from : null;
    if (key) used.add(key);
    else missing.push(id);
    return {
      id,
      meaning: key ? CHECK_MEANINGS[key]! : '',
      severity: ADVISORY_CHECKS.includes(id) ? 'advisory' : 'required',
      repair: checkRepair(id),
    };
  });
  return {
    checks,
    missing,
    unused: Object.keys(CHECK_MEANINGS).filter((key) => !used.has(key)),
  };
}

/** schema/check-ids.json. */
export function renderCheckRegistry(root = PACKAGE_ROOT): string {
  const { checks, missing, unused } = checkRegistry(root);
  if (missing.length || unused.length)
    throw new Error(
      `Check IDs without a meaning: ${missing.join(', ') || 'none'}; meanings no check uses: ${unused.join(', ') || 'none'}.`
    );
  return `${JSON.stringify(
    {
      $comment:
        'Generated by `bun src/check-registry.ts > schema/check-ids.json` from the checks the code reports; features/rules/contracts.feature fails when this file differs. Every check ID dev-fleet reports: what a passing check means; severity, required (a failure blocks readiness unless the run marks the check out of scope) or advisory (reported as a warning or as not required, never blocking); and repair, the fleet-repair recipe that repairs it or the reason only a person can (manual). A * stands for a name taken from the fleet configuration, a machine or a tool at run time.',
      version: 1,
      checks,
    },
    null,
    2
  )}\n`;
}

if (import.meta.main) process.stdout.write(renderCheckRegistry());
