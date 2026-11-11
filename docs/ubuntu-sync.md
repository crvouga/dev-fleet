> This document was written for the fleet dev-fleet was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative.

# Developer fleet: one manager (macOS) and stateless workers (Ubuntu)

## Release status

This working-tree implementation is **not yet a completed or published fleet
release**. Do not describe it as having configured Chris’s machines. Required
acceptance checks remain incomplete: multi-target remote/bootstrap fault tests, unattended
paired T3 execution and live private-route acceptance, all five live provider routes, manager boot/scheduling acceptance,
off-host monitoring recovery, and the full Ubuntu drift/fault matrix. Disposable Ubuntu baseline
apply/repeat/reboot and pinned native T3 install/repeat/crash recovery/reboot passed.
The production boot-policy observer also passed inside the rebooted VM. Pinned
Beszel hub installation (including a missing Docker engine), repeat no-op and
reboot passed. Native Beszel agent installation, repeat no-op, crash recovery and
reboot also passed with an intentionally unreachable fixture hub; private metrics
acceptance remains separate. A further full SSH bootstrap test caught a T3 archive verification bug: release-builder UID/GID values are not the designated installation user. The shared installer now verifies local ownership, content, modes and links independently of archive-builder identity. The same test exposed restrictive-umask extraction drift; archive modes are now preserved and staging is verified before promotion. A fresh Ubuntu VM now passes the production strict-SSH source transfer, missing-prerequisite bootstrap, shared tool installation and baseline, then repeats with preserved SSH identity, developer work and managed-file timestamps. This uses a disposable exact test commit, not a published release or live fleet. Multi-target and interruption acceptance remains open. The VM caught and fixed an Ansible piped-stdin
variable-loading failure; runtime variables now use a private temporary file with
cleanup and never enter command arguments. See the
[reproducible VM test instructions](../../fleet/ubuntu/tests/README.md).
Real Beszel 0.21.1 binaries passed authenticated metrics, identity preservation and
supported API backup/restore in an isolated loopback fixture; that is not live fleet evidence. Incomplete
checks return nonzero; they do not advance a successful fleet receipt.

Newest and still unverified against live machines: the macOS convergence path
(`ansible/macos`, launchd Beszel agent, fcntl remote lock), the Linux
always-on service drop-ins, and dashboard evidence inside `fleet-status --workers`.
They pass unit tests and Ansible syntax checks only; treat them as unaccepted
until a disposable-machine run and a live manager run are recorded.

## One command, from the manager

```sh
devfleet fleet-sync
```

`devfleet fleet-sync` executes the manager-push implementation:

```text
resolve enrolled fleet
→ inspect Tailscale and verified SSH
→ bootstrap missing remote prerequisites
→ apply one approved exact revision
→ establish fresh SSH connections and check readiness
→ report every target, including offline and blocked nodes
```

Bare invocation selects every canonical Linux and macOS node. It does not mean
“this computer,” and the manager is not implicitly a deployment target. Its own
node is targeted only if explicitly declared in Fleet membership. Ubuntu 26.04 is
the accepted worker platform; a node declared `"os": "macOS"` runs the same phases
best effort through `ansible/macos` (see the platform matrix below).
Windows machines stay declared for diagnostics and are never converged.
`--node ID` filters troubleshooting/rollout. `--all` is an explicit spelling of the
default. Neither flag authorizes managing arbitrary Tailscale peers.

Roster-level workspace convergence lives in `devfleet fleet-repair --repair workspace`, which previews until `--apply --yes`.
The new manager report is version **2**, deliberately replacing the unshipped
local-first fleet-sync version 1 contract.

## Prerequisites and first enrollment

The manager needs Node/npm (Node `^22.13.0 || >=23.5.0`), an OpenSSH client,
a working Tailscale daemon, and Git for approved source preparation. npx cannot
execute without Node/npm. Existing shared setup remains
[`bootstrap/bootstrap.sh`](../../../bootstrap/bootstrap.sh); run that tracked
bootstrap on a manager without developer tools, then invoke the same command.
Do not install an unrelated fleet installer. The npm command’s help, catalog and
structured missing-enrollment result require neither Bun nor a checkout.

On first interactive use the command resolves only canonical machines through
existing SSH aliases, tests strict SSH access, and offers one enrollment
confirmation for the verified connections. The apply approval binds a fingerprint
of the selected revision, policy and connection records; changed bindings fail
with `FLEET_PLAN_STALE` before source preparation or remote mutation. It stores private overrides mode 0600. Unknown host keys are never accepted automatically. Compare fingerprints
out of band before enrolling trust. Unreachable machines remain listed; first
reachability requires an existing trusted LAN SSH route or physical setup of
SSH/Tailscale. No software on the manager can bootstrap a disconnected box.

A previously configured manager uses saved connection bindings and its approved
revision. A changed Tailscale device ID is a replacement gate, even if the old
DNS name and SSH alias still resolve. Enrollment never copies host keys,
Tailscale state, provider OAuth, or another machine’s T3 environment.

Remote developer-tool prerequisites are not required: the initial SSH probe uses
POSIX facilities. Approved application sends a Git bundle of that one commit
(its files, no history; the worker checkout is shallow) and the bootstrap
script extracted from that exact commit over verified SSH. A worker that
already has the revision receives nothing, and the toolchain setup is skipped
while its inputs (`mise.toml`, the locks, `scripts/dev`) are unchanged since a
successful setup within the last day. It installs missing
Ubuntu bootstrap packages through signed APT, then uses the existing mise and
frozen dependency installer. Bootstrap APT packages currently use the installed
Ubuntu archive configuration; strict dependency closure/snapshot promotion is a
remaining parity gate. The interactive manager flow can request native sudo authorization over a verified SSH terminal after the consolidated apply confirmation. It validates and installs the designated-user sudo policy; passwords are never captured or stored. Missing administrator permission, an unmanaged conflicting sudoers fragment, or unavailable terminal remains action-required. JSON and unattended runs never prompt and require existing noninteractive sudo.

## Policy, ownership and private state

- `fleet.json` and `definition.schema.json`: portable machine
  IDs, aliases, OS, singleton roles and Ubuntu release policy.
- Private manager overrides: `--config PATH`, `PERSONAL_FLEET_CONFIG`, or the
  roster in the [fleet state](state.md), using the existing roster schema.
  Preserve workspace/runtime paths, capabilities and explicit `tailscaleId`
  bindings.
- Workstation network consumers derive their inventory from Fleet. The old file
  is retained only as `packages/fleet/migrations/workstation-network-v1.json` for
  lossless identity-path migration; conflicts fail rather than silently winning.
- Manager approval: the `enrollment` document in the [fleet state](state.md).
  Manager deployment lock: `~/.local/share/personal/fleet/manager/sync.lock`.
- Remote source: `~/.local/share/personal/fleet/revisions/FULL_SHA`.
  Remote lock file: `~/.local/share/personal/fleet/remote-operation.lock`, held
  with `flock` on Linux and the same descriptor through Python `fcntl` on macOS.
  Never repurpose a development checkout or reset dirty worktrees.
- Fleet owns `ubuntu/`, `macos/` and `monitoring/`; mise manifests, locks and
  `scripts/dev` own developer tools. CLIProxy deployment/auth/recovery stays with
  `cliproxy`. Cloud resources, DNS, Vault policy and tailnet access
  policy stay with OpenTofu and are not modified by this command.

The repository is public. Existing portable host metadata was retained during
migration; do not publish device IDs, private keys, manager-specific secrets,
credentials, backups or runtime databases. Intentional persistent policy changes
must be reviewed in Git. Emergency service restarts do not authorize permanent
untracked configuration edits.

## Preview, approval and results

```sh
devfleet fleet-sync --dry-run --json
devfleet fleet-sync --revision FULL_40_CHARACTER_SHA --dry-run --json
devfleet fleet-sync --revision FULL_40_CHARACTER_SHA --non-interactive --json
```

Preview can query Tailscale and establish read-only SSH sessions. It never enrolls,
authenticates to a provider, installs, creates pairing material, schedules work or
writes configuration. JSON/noninteractive modes never prompt or open a browser.
`fleet-sync` applies on invocation with no confirmation prompt; use `--dry-run`
to preview. `--apply --yes` is still accepted for existing scripts. Initial
trust/enrollment of new connections still asks separately.

Select one full lowercase commit SHA. Approval is saved on the manager and
retained throughout the run. New package versions do not silently replace saved
approval. Promote a reviewed release with the explicit `--revision SHA` invocation.
Use `devfleet@VERSION fleet-sync ...` for automation; unversioned npx
is convenience, not a reproducibility guarantee. Dirty review artifacts have no
automatically approved source SHA.

Version 2 JSON contains `execution: manager-push`, desired revision, per-node
reachability, applied revision (null when not verified), checks, durations,
candidate count and the private dashboard URL when the enrolled hub resolves.
An absent applied revision is not “unchanged.” Every required skip/failure keeps
readiness incomplete. Exit 0 means the requested read-only inspection or required
checks passed; 1 means incomplete/action-required/failed; 2 means invalid usage or
refused configuration. JSON is one document on stdout, with no child process logs.

These are distinct facts: configuration applied; local services healthy; fresh
manager connection verified; authenticated IDE/T3 tool execution verified.
Neither an HTTP 200 nor a successful installer establishes the last fact.

## Machine policy by platform

Every machine-level setting is declared in Ansible using only `ansible.builtin`
modules, applied by `node-converge` after source bootstrap, and then measured
independently. Bespoke TypeScript remains only where a native CLI or API has no
declarative owner: T3 service lifecycle, Beszel enrollment tokens, provider
verification and the CLIProxy singleton.

| Policy                      | Workers (Ubuntu 26.04, stateless)                                                                                                                                                                                                                                                                                                                                                                                                                   | Manager (macOS, singleton)                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never sleep                 | systemd sleep targets masked; logind lid/idle policy; GNOME power plugin set to `nothing`                                                                                                                                                                                                                                                                                                                                                           | never sleeps on AC power (`pmset -c sleep 0`, `macos/manager.yml`, verified as `manager:power`); battery sleep is left to the human                                                                                                                                                                                                                                                                       |
| No automatic logout or lock | GNOME `lock-enabled false`, `idle-delay 0`; designated-user lingering                                                                                                                                                                                                                                                                                                                                                                               | not managed (the human uses it)                                                                                                                                                                                                                                                                                                                                                                           |
| Always-on services          | drop-ins `Restart=always`, `StartLimitIntervalSec=0` for ssh, tailscaled, docker, beszel-agent                                                                                                                                                                                                                                                                                                                                                      | singleton services under launchd and Docker Desktop (see the last row)                                                                                                                                                                                                                                                                                                                                    |
| T3 health and connection    | `fleet-sync` and `fleet-status --workers` require `worker:t3-health` (local API answers), `t3:manager-endpoint` (manager HTTPS over Tailscale) and `t3:paired-access` (manager T3 link reachable)                                                                                                                                                                                                                                                   | the human's T3 desktop holds the links to every worker (`t3:paired-access`)                                                                                                                                                                                                                                                                                                                               |
| Memory safety               | `systemd-oomd` (swap 90%, pressure 60%); `user.slice` `MemoryMax=90%`; each `t3code-*.scope` agent `MemoryMax=30%`, `OOMPolicy=continue`; swap file when none                                                                                                                                                                                                                                                                                       | not managed                                                                                                                                                                                                                                                                                                                                                                                               |
| Disk safety                 | `personal-fleet-disk-guard` kills only the top user-cgroup writer below 3 GiB free, never deletes files; journal 1G; `/tmp` 25% of RAM, aged 2d hourly, a measured write probe (`TMP_QUOTA_EXHAUSTED`), and T3 agents use disk-backed `/var/tmp` (`TMPDIR`, aged 14d); Docker log rotation                                                                                                                                                          | not managed                                                                                                                                                                                                                                                                                                                                                                                               |
| Tailscale                   | pinned APT package, `tailscaled` enabled, native login required                                                                                                                                                                                                                                                                                                                                                                                     | Tailscale app, human login                                                                                                                                                                                                                                                                                                                                                                                |
| Dashboard agent             | pinned native binary, hardened `beszel-agent` systemd unit as user `beszel`                                                                                                                                                                                                                                                                                                                                                                         | not installed                                                                                                                                                                                                                                                                                                                                                                                             |
| Credential renewal          | user timer `personal-worker-auth` renews the node's own Vault token and GitHub login every 10min                                                                                                                                                                                                                                                                                                                                                    | the human's own Vault and GitHub sessions                                                                                                                                                                                                                                                                                                                                                                 |
| Noninteractive sudo         | validated `/etc/sudoers.d/personal-fleet-USER`                                                                                                                                                                                                                                                                                                                                                                                                      | never; the human runs `manager.yml` once with `-K`                                                                                                                                                                                                                                                                                                                                                        |
| T3 worker app               | pinned desktop `.deb` is the only T3 process (UI plus embedded server); GDM auto-login, user unit `t3code-desktop.service` bound to the graphical session with `Restart=always`; `personal-worker-recovery` checks every minute, starts a stopped app and restarts one whose local API missed three checks; administrator policy. A still-running headless `t3code.service` reports `T3_DESKTOP_MIGRATION_REQUIRED` (stopping it ends active turns) | not a worker                                                                                                                                                                                                                                                                                                                                                                                              |
| T3 providers                | the same managed instances (`fleet/agents/t3.json`) through locked T3 administrator policy                                                                                                                                                                                                                                                                                                                                                          | reconciled into the human's T3 settings by `fleet-sync` (`t3:providers`) with the ownership-safe `t3-apply` engine, so every T3 offers the identical set; unrelated and unmanaged instances are preserved. `fleet-sync` also applies the same proxy agent profiles (`configuration:apply`) and verifies the shared Vault gateway credential end to end with `provider:*:inference`, exactly as on workers |
| Singleton services          | never; clients of the manager's services only                                                                                                                                                                                                                                                                                                                                                                                                       | every singleton runs here: CLI proxy (`cliproxy`), Beszel hub (`workstation/monitoring`)                                                                                                                                                                                                                                                                                                                  |

Credential sync is deliberately indirect: no secret is copied between machines.
OpenTofu issues each enrolled worker its own renewable periodic token
(`vault.tokens` entries `fleet-worker-<node>`, policy `personal-read`, sunk into
`secret/personal/prd` as `FLEET_WORKER_TOKEN_<NODE>`). `devfleet fleet-sync`
delivers each node's token automatically over SSH stdin (never as an argument)
whenever that node has no working Vault session. Interactive runs first log the
manager in (`vault login -method=userpass`, password typed on your terminal)
and fall back to the same password login on a node whose token is not issued.
Without either, the node reports `VAULT_LOGIN_REQUIRED` and its T3 proxy
providers stay unavailable. The manual equivalent of the automatic delivery:

```sh
vault kv get -field=FLEET_WORKER_TOKEN_WORKER_ONE secret/personal/prd \
  | ssh worker-one 'vault login -address=https://vault.example.com -no-print -'
```

From then on the node's `personal-worker-auth` timer renews that token and its
GitHub login, and renders provider configuration from Vault through Workstation.

## Ubuntu and remote-work safety

The declared common baseline is Ubuntu **26.04 LTS**, amd64/arm64. Other releases
receive `UBUNTU_BASELINE_MISMATCH`; there is no automatic release upgrade or
package downgrade. Fleet audits release, packages, service state and dpkg
consistency, declares snapshot sources for managed transactions, and pins its
selected APT packages. Unrelated applications and package sources are preserved.

Power policy masks sleep/hibernate targets and declares logind sleep/lid defaults.
GNOME lock/idle changes apply to the designated user only. Effective running
session/logind behavior still needs a maintenance/reboot acceptance check; writing
a file does not prove logout/reboot survival. The sudoers fragment is validated
with visudo before installation; this user and its agents can administer the
machine. SSH authentication remains enabled.

SSH forwarding changes validate the complete configuration before reload and
restore the previous fragment on validation failure. Existing listeners,
authentication and firewall rules are preserved. Existing socket activation is preserved for forwarding-only changes; listener
migrations and unmanaged fragments require review. The manager makes a **new**
strict SSH connection after apply. Private-listener/firewall acceptance and
failure-after-reload recovery still require disposable integration testing.

The manager is the only configuration coordinator. No per-node pull timer is
installed. Manager schedule controls use the existing platform adapter:

```sh
devfleet fleet-sync --schedule status --json
devfleet fleet-sync --schedule enable --revision FULL_40_CHARACTER_SHA --apply --yes
devfleet fleet-sync --schedule pause --apply --yes
devfleet fleet-sync --schedule resume --revision FULL_40_CHARACTER_SHA --apply --yes
devfleet fleet-sync --schedule disable --apply --yes
```

These are manager setup/maintenance operations, not per-node commands. Enable
and resume install the exact published CLI version in the managed manager
runtime and schedule the same whole-fleet command every 30 minutes at the explicit
approved SHA. They refuse dirty artifacts. Pause/disable remove only the manager
schedule. Re-enable with the new approved SHA when promoting a release; the timer
does not resolve `latest`. Linux user scheduling requires lingering; macOS uses
the existing LaunchAgent and requires a user session. Unattended manager boot
acceptance and log-retention configuration remain gates. No node pull scheduler
is installed or necessary.

Sync never reboots a box. It does restart a worker's T3 when a new provider
policy is staged, which ends that T3's running turns. Explicit
maintenance reboot/reconnect orchestration remains an acceptance gate. Kernel,
driver, firmware, hardware and power failures are outside any “never freezes”
promise. Inspect disk/inodes, swap/memory pressure, `systemctl --failed`, and prior
boot journal evidence locally; sanitize it before sharing. Do not enable automatic
reboot-on-pressure or kill active work to obtain a green report.

T3 0.1.7's supported administrator policy at `/etc/t3code/policy.json`
disables independent updates and declares the existing managed Codex instance
plus an OpenCode instance for all five gateway models. Fleet reuses the
existing `agents/t3.json` renderer; it does not edit the live settings database.
Native `t3 policy check` validates before installation, and `t3 policy show`
compares staged policy with the running server. A staged policy the running
server has not loaded restarts the T3 desktop app in the same sync;
`T3_POLICY_RESTART_FAILED` means it still did not load afterwards.
Unrelated administrator policy is a conflict requiring a reviewed merge.

## Central provider access

The `https://cli-proxy.example.com` gateway is a singleton service, so it
runs on the manager (`definition.json.services.proxy`). Workers consume that
gateway; no worker gets a separate OAuth-owning proxy. Keep the existing
key/endpoint contract, encrypted recovery and runtime authentication. Moving it
requires fencing the old host before restoring state
([migration](../../cliproxy-fleet/docs/migration.md)). Fleet never copies identities.

### Agents on every node

Every node (manager and workers) offers the same agents in T3, at the same
versions (pinned in `mise.toml`/`mise.lock`, including the vendor CLIs
`http:grok` and `http:antigravity`), signed in to the same multiplexed proxy
accounts. T3 launches most through a tracked launcher in
`agents/` that injects the shared proxy key from Vault at
launch; nothing is copied between nodes.

| T3 provider                   | T3 driver     | Route                                                           |
| ----------------------------- | ------------- | --------------------------------------------------------------- |
| `Claude <account email>`      | `claudeAgent` | One per Claude account on the proxy (`claude-proxy`)            |
| `Codex <account email>`       | `codex`       | One per Codex account on the proxy (`codex-proxy.ts`)           |
| `AntiGravity <account email>` | `opencode`    | One per Antigravity account, via OpenCode (`opencode-proxy.ts`) |
| `Grok CLI Proxy`              | `grok`        | Pooled: Grok Build custom model, `env_key` (`grok-proxy.ts`)    |
| `OpenCode CLI Proxy`          | `opencode`    | Pooled accounts and Muse via OpenCode (`opencode-proxy.ts`)     |

**Ansible applies, TypeScript measures.** On a worker the T3 lifecycle is
declared in playbooks: `t3-policy.yml` stages the provider policy and restarts
a running T3 that has not loaded it, `t3-desktop.yml` installs the app, retires
the former headless server and starts it, and `t3-route.yml` publishes the
private tailnet route when port 443 has no owner. The TypeScript around them
only refuses conflicts and reports what it observes afterwards. Each sync also
prunes old revision checkouts on the worker, keeping the new one, the one T3
launches from and the two most recent others.

**Every sync applies everything.** `fleet-sync` never waits for a quiet
moment: a worker whose T3 has not loaded the staged provider policy is
restarted (ending its running turns), and a pending proxy update is installed
even when it recreates the gateway. The manager finishes before the workers
start, so they are verified against the updated proxy. `--dry-run` previews.

**Accounts are never listed in this repository.** The proxy's credential files
are the only source of truth: every sync gives each Claude, Codex and
Antigravity credential the model prefix `<type>-<email>`
(`cliproxy/scripts/accounts.py`, applied through the proxy's own
API), so the proxy's model list names every signed-in account. Each node reads
that list with its own proxy key and offers one provider per account, so all
machines list the same providers. Signing an account in or out on the proxy
(`devfleet cliproxy add-account PROVIDER`, or the dashboard) changes T3 on the
next `fleet-sync`; an unreachable proxy fails the check and changes nothing.

A provider is pinned to its account: T3 sets `WS_AGENT_ACCOUNT` and the
launcher routes every request to `<type>-<email>/<model>`. Claude and Codex
send whichever model is picked, so their launcher runs a loopback relay
(`account-relay.ts`, alive only while that agent runs) that adds the prefix;
OpenCode is configured with exactly the account's models. Requests without a
prefix (Grok, the pooled OpenCode provider, health checks) still use the whole
pool, fill-first. T3's own Antigravity runtime cannot carry an account, so
Antigravity accounts run on the OpenCode harness. Cursor is not part of the
fleet (its backend cannot be proxied). Native Muse Code is not used: it only
talks to Meta's own catalog endpoint, so Muse models run through OpenCode.

### Checkout project actions

`bash bootstrap/project-action.sh fleet-sync` warms the shared toolchain
and passes the current checkout HEAD as the exact revision to the existing approval
flow. Extra arguments such as `--dry-run` are forwarded. The manager can bundle
committed objects from this canonical local repository, including unpublished
commits; dirty working files are never transferred. Review and commit desired
changes before approving deployment. The Ubuntu baseline now owns the native
Docker engine, Compose and Buildx on every enrolled Linux workstation, preserving
third-party engine ownership conflicts and existing running workloads. Workstation
launcher/link convergence is part of the node apply, with credentials still checked
separately. A dependency receipt proves frozen installation inputs only.
