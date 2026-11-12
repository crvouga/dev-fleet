> This document was written for the fleet dev-fleet was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative.

# Developer fleet: one manager (macOS) and stateless workers (Ubuntu)

## Release status

What is proven, and where:

| Evidence                                                                 | Where                                                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A bare Ubuntu 26.04 machine bootstrapped over real SSH, then repeated    | `features/fresh-box/fresh-box.feature`, on every pull request (amd64 and arm64)                                                           |
| One run over several machines, one versioned report, no partial receipt  | `features/fresh-box/fleet.feature`                                                                                                        |
| Interrupted checkout, package installation and toolchain setup resumed   | `features/fresh-box/fleet.feature`                                                                                                        |
| Overlapping runs, a dropped connection, a held APT lock, no DNS, no disk | `features/fresh-box/fleet.feature`                                                                                                        |
| A failed canary stops promotion; a changed host key is never touched     | `features/fresh-box/fleet.feature`, `features/orchestration/fleet-sync.feature`                                                           |
| Offline, unapproved and replaced devices                                 | `features/orchestration/fleet-sync.feature` (the tailnet is injected)                                                                     |
| T3 route, origin policy, pairing redaction, service environment          | `features/core/t3-access.feature`, `features/agents/native-agents.feature`                                                                |
| Vault renewal and policy outcomes, provider incompatibilities            | `features/core/worker-checks.feature`, `features/agents/provider-failures.feature`                                                        |
| Beszel agent privileges, evidence, backups and the stock API             | `features/monitoring/`, and `ansible/monitoring/tests/upstream.py` against the pinned binaries (backup restored into a separate instance) |

A container has no systemd, so the fresh-box runs prove bootstrap,
interruption and fault handling, not a booted desktop session. What only a
live fleet can show is checked by `fleet-sync` itself on every run and stays a
failed or skipped required check until it is true; nothing advances a success
receipt before then:

- the private T3 route reached from a separate tailnet client, and a paired
  conversation with a tool action (`t3:manager-endpoint`, `t3:paired-access`,
  `t3:end-to-end`);
- each provider route signed in on its real account, under the T3 service's
  environment (`provider:*`, `agent:service-environment`);
- unattended Vault renewal under the fleet's real policy
  (`worker:vault-renewal`, `worker:proxy-authentication`);
- private Beszel metrics from every worker and a scheduled off-host hub backup
  (`beszel:*`, `beszel:backup`);
- reboot, logout and crash recovery of a real GNOME session
  (`worker:t3-recovery`, `ubuntu:boot-policy`).

Reproduce the disposable runs with
`DEVFLEET_TEST_FRESH_BOX=1 bun test features/fresh-box`; the VM procedure for
a full systemd guest is in [`ansible/ubuntu/tests/README.md`](../ansible/ubuntu/tests/README.md).

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
node is targeted only if explicitly declared in Fleet membership. Workers are the
Ubuntu releases the [support matrix](support-matrix.md) lists; it also says what
is refused (macOS and Windows workers, WSL2, containers) and why.
`--node ID` filters troubleshooting/rollout. `--all` is an explicit spelling of the
default. Neither flag authorizes managing arbitrary Tailscale peers.

Roster-level workspace convergence lives in `devfleet fleet-repair --repair workspace`, which previews until `--apply --yes`.
The new manager report is version **2**, deliberately replacing the unshipped
local-first fleet-sync version 1 contract.

## Prerequisites and first enrollment

The manager needs Node/npm (Node `^22.13.0 || >=23.5.0`), an OpenSSH client,
a working Tailscale daemon, and Git for approved source preparation. npx cannot
execute without Node/npm. Existing shared setup remains
[`bootstrap/bootstrap.sh`](../bootstrap/bootstrap.sh); run that tracked
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
frozen dependency installer. Bootstrap APT packages use the installed Ubuntu
archive configuration, because a new machine cannot reach the HTTPS snapshot
before it has CA certificates; the baseline then pins each of them, Ansible
included, to the exact version in `ansible/ubuntu/policy.json`. The interactive manager flow can request native sudo authorization over a verified SSH terminal after the consolidated apply confirmation. It validates and installs the designated-user sudo policy; passwords are never captured or stored. Missing administrator permission, an unmanaged conflicting sudoers fragment, or unavailable terminal remains action-required. JSON and unattended runs never prompt and require existing noninteractive sudo.

## Policy, ownership and private state

- `fleet.json` and `definition.schema.json`: portable machine
  IDs, aliases, OS, singleton roles and Ubuntu release policy.
- Private manager overrides: `--config PATH`, `PERSONAL_FLEET_CONFIG`, or the
  roster in the [fleet state](state.md), using the existing roster schema.
  Preserve workspace/runtime paths, capabilities and explicit `tailscaleId`
  bindings.
- Workstation network consumers derive their inventory from the fleet
  configuration; conflicts fail rather than silently winning.
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

| Policy                      | Workers (Ubuntu 26.04, stateless)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Manager (macOS, singleton)                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never sleep                 | systemd sleep targets masked; logind lid/idle policy; GNOME power plugin set to `nothing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | never sleeps on AC power (`pmset -c sleep 0`, `macos/manager.yml`, verified as `manager:power`); battery sleep is left to the human                                                                                                                                                                                                                                                                       |
| No automatic logout or lock | GNOME `lock-enabled false`, `idle-delay 0`; designated-user lingering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | not managed (the human uses it)                                                                                                                                                                                                                                                                                                                                                                           |
| Always-on services          | drop-ins `Restart=always`, `StartLimitIntervalSec=0` for ssh, tailscaled, docker, beszel-agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | singleton services under launchd and Docker Desktop (see the last row)                                                                                                                                                                                                                                                                                                                                    |
| T3 health and connection    | `fleet-sync` and `fleet-status --workers` require `worker:t3-health` (local API answers), `t3:manager-endpoint` (manager HTTPS over Tailscale) and `t3:paired-access` (manager T3 link reachable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the human's T3 desktop holds the links to every worker (`t3:paired-access`)                                                                                                                                                                                                                                                                                                                               |
| Memory safety               | `systemd-oomd` (swap 90%, pressure 60%); `user.slice` `MemoryMax=90%`; each `t3code-*.scope` agent `MemoryMax=30%`, `OOMPolicy=continue`; swap file when none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | not managed                                                                                                                                                                                                                                                                                                                                                                                               |
| Disk safety                 | `personal-fleet-disk-guard` kills only the top user-cgroup writer below 3 GiB free, never deletes files; hourly `personal-fleet-disk-gc.timer` deletes git-ignored build output (`node_modules`, `.cache`, `dist`, ...) in checkouts idle 7d (12h under 15 GiB free) with no process inside, plus unused Docker images and build cache, never source, worktrees or volumes; journal 1G; `/tmp` 25% of RAM, aged 2d hourly, a measured write probe (`TMP_QUOTA_EXHAUSTED`), and T3 agents use disk-backed `/var/tmp` (`TMPDIR`, aged 14d); Docker log rotation                                                                                                                                                                                                                                                                                                                                        | not managed                                                                                                                                                                                                                                                                                                                                                                                               |
| Tailscale                   | pinned APT package, `tailscaled` enabled, native login required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Tailscale app, human login                                                                                                                                                                                                                                                                                                                                                                                |
| Dashboard agent             | pinned native binary, hardened `beszel-agent` systemd unit as user `beszel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | not installed                                                                                                                                                                                                                                                                                                                                                                                             |
| Credential renewal          | user timer `personal-worker-auth` renews the node's own Vault token every 10min; `personal-worker-github` signs it in to GitHub from the stored token ([GitHub](github.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | the human's own Vault and GitHub sessions                                                                                                                                                                                                                                                                                                                                                                 |
| Noninteractive sudo         | validated `/etc/sudoers.d/personal-fleet-USER`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | only `pmset -c`, granted once by `manager-privilege.yml` (`-K`)                                                                                                                                                                                                                                                                                                                                           |
| T3 worker app               | pinned desktop `.deb` is the only T3 process (UI plus embedded server) on a desktop worker, and the pinned server as the lingering user unit `t3code-headless.service` on a headless one (`features.session`; no session is waited for); GDM auto-login, user unit `t3code-desktop.service` bound to the graphical session with `Restart=always`; `personal-worker-recovery` runs a copy of `t3-health.sh` installed in `/usr/local/lib/personal-fleet` every minute: it stops and disables a still-running headless `t3code.service`, reports `T3_NO_GRAPHICAL_SESSION` and restarts the display manager (three times at most) when there is no session, starts a stopped app after `reset-failed`, restarts one whose local API missed three checks, and restarts one on another release than the installed one or with a deferred policy restart once it runs no agent turn; administrator policy | not a worker                                                                                                                                                                                                                                                                                                                                                                                              |
| T3 providers                | the same managed instances (`fleet/agents/t3.json`) through locked T3 administrator policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | reconciled into the human's T3 settings by `fleet-sync` (`t3:providers`) with the ownership-safe `t3-apply` engine, so every T3 offers the identical set; unrelated and unmanaged instances are preserved. `fleet-sync` also applies the same proxy agent profiles (`configuration:apply`) and verifies the shared Vault gateway credential end to end with `provider:*:inference`, exactly as on workers |
| Singleton services          | never; clients of the manager's services only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | every singleton runs here: CLI proxy (`cliproxy`), Beszel hub (`workstation/monitoring`)                                                                                                                                                                                                                                                                                                                  |

Credential sync is deliberately indirect: no secret is copied between machines.
Each worker has a Vault token of its own, kept in a document of its own,
`<mount>/<project>/workers/<id>` (fields `token` and `accessor`; `<project>`
is the first segment of the `proxy-client-key` path). The manager issues it
with `devfleet fleet-node-replace --id ID --apply --yes`: a periodic orphan
token under the policy `fleet-worker-<id>`, which reads the fleet's shared
document and the worker's own document and nothing else, so one worker's
token cannot read another's (`features/fleet-sync/worker-credentials.feature`
proves it against a Vault development server). The manager's own login needs
to write policies, create tokens and write the mount.

`devfleet fleet-sync` delivers each node's token over SSH stdin (never as an
argument) whenever that node has no working Vault session. A token still kept
in the shared document as `FLEET_WORKER_TOKEN_<NODE>` is delivered too, with
the warning `VAULT_WORKER_TOKEN_SHARED`: every worker can read that document,
so issue the worker its own token and remove the field. A password login with
the fleet's shared Vault user on the worker's own terminal happens only with
`fleet-sync --vault-password-login`. Without a token the node reports
`VAULT_LOGIN_REQUIRED` and its T3 proxy providers stay unavailable.
`devfleet fleet-node-retire --id ID --apply --yes` revokes a worker's token by
its accessor and removes its document and policy.

From then on the node's `personal-worker-auth` timer renews that token and its
`personal-worker-github` timer keeps its GitHub sign-in current
([GitHub](github.md)). It renders no provider configuration: agent profiles
are applied by `fleet-sync`. See [Authentication and accounts](authentication.md).

## Ubuntu and remote-work safety

The accepted releases are named once, in `ansible/ubuntu/policy.json`, and
listed in the [support matrix](support-matrix.md). Other releases receive
`UBUNTU_BASELINE_MISMATCH`, and WSL2 and containers
`WORKER_ENVIRONMENT_UNSUPPORTED`; there is no automatic release upgrade or
package downgrade. Package pins are minimums: see the
[worker contract](worker-contract.md#package-pins-and-security-updates). Fleet audits release, packages, service state and dpkg
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

Sync never reboots a box and never ends a running agent turn. A worker's T3
that must restart for a new provider policy or release is restarted only while
it runs no agent turn; otherwise the restart is pending
(`T3_POLICY_RESTART_PENDING`, `T3_RESTART_PENDING`) and the recovery timer
applies it at the first idle check. Explicit
maintenance reboot/reconnect orchestration remains an acceptance gate. Kernel,
driver, firmware, hardware and power failures are outside any “never freezes”
promise. Inspect disk/inodes, swap/memory pressure, `systemctl --failed`, and prior
boot journal evidence locally; sanitize it before sharing. Do not enable automatic
reboot-on-pressure or kill active work to obtain a green report.

The pinned T3's (`t3_version` in `mise.toml`) supported administrator policy at `/etc/t3code/policy.json`
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
([migration](../cliproxy/docs/migration.md)). Fleet never copies identities.

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
a running T3 that has not loaded it once it runs no agent turn, `t3-desktop.yml` installs the app, retires
the former headless server and starts it, and `t3-route.yml` publishes the
private tailnet route when port 443 has no owner. The TypeScript around them
only refuses conflicts and reports what it observes afterwards. Each sync also
prunes old revision checkouts on the worker, keeping the new one, the one T3
launches from and the two most recent others.

**Every sync applies everything, except a T3 restart that would end a turn.**
A worker whose T3 has not loaded the staged provider policy, or runs an older
release than the one installed, is restarted only while it runs no agent turn;
otherwise sync reports the pending restart and the recovery timer applies it
at the first idle check, failing the check after
`t3RestartMaxDeferralHours` (`ansible/ubuntu/policy.json`). A pending proxy
update is installed even when it recreates the gateway. The manager finishes before the workers
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
