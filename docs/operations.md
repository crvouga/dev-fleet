> This document was written for the fleet dev-fleet was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative.

# Developer fleet

`devfleet` diagnoses development computers: SSH, VS Code Remote-SSH,
per-machine authentication, T3 Connect and shared toolchain/dependency drift.
It is a local CLI, not a library, a daemon or a cloud manager. It reuses the
existing mise/workstation owners rather than introducing another installer.

The fleet is one singleton **manager** (the human's macOS machine, which runs
`fleet-sync` and every singleton service such as the CLI proxy and Beszel hub)
and stateless Linux **workers**. See [topology](topology.md).

See [Ubuntu fleet-sync implementation and operator status](ubuntu-sync.md) for
the manager-driven public command and its outstanding full-machine gates.

## Worker contract

Use `devfleet fleet-sync` to reconcile all declared workers and
`devfleet fleet-status --workers` to inspect remaining gaps. See
[worker-contract.md](worker-contract.md) for bootstrap, ownership and the exact
scope of readiness. `fleet-status` without flags diagnoses the local roster.
Workers are Ubuntu 26.04 or 24.04; the manager is macOS and never sleeps on AC power
(`ansible/macos/manager.yml`). Machine policy (never sleep, no automatic
logout, always-on Tailscale/SSH/Docker/Beszel, memory and disk safety, per-node
credential renewal) is
declared in Ansible and measured by `fleet-status --workers`, which also verifies
the centralized Beszel dashboard. See the
[platform matrix](ubuntu-sync.md#machine-policy-by-platform).

## Quick start

Run from the repository root after `bun install --frozen-lockfile`:

```sh
devfleet fleet-node-add --id dev-linux --ssh dev-linux --path /home/dev/workspace --json
devfleet fleet-node-add --id dev-linux --ssh dev-linux --path /home/dev/workspace --apply --yes --json
devfleet fleet-nodes --json                        # validate the roster; no network
devfleet fleet-nodes --onboard --node dev-linux --json
devfleet fleet-status --json                       # manager + all roster nodes
devfleet fleet-status --node dev-linux --json
devfleet fleet-status --local --json               # no roster/SSH needed
devfleet fleet-repair --node dev-linux --repair workspace --json   # plan only
devfleet fleet-repair --node dev-linux --repair workspace --apply --yes --json
```

dev-fleet is a command with no library API: run it as `npx devfleet` from the
project that holds your `fleet.json` (`./devfleet` from a checkout of dev-fleet
itself). Schema, roster
listing, onboarding and repair previews do not contact nodes or auth services.
Status never opens a login flow.

## Roster

The roster is kept in the [fleet state](state.md) and replicated to its bucket.
A `.fleet.local.json` found from the current working directory (gitignored), or
`--config PATH`, names a roster file instead (keep it out of Git yourself). This describes
**existing developer computers**, not desired cloud infrastructure. OpenTofu
remains the sole cloud resource owner; fleet creates no networks, hosts or secrets.

```json
{
  "$schema": "./node_modules/@crvouga/dev-fleet/schema/roster.schema.json",
  "version": 1,
  "nodes": [
    {
      "id": "dev-linux",
      "ssh": "dev-linux",
      "workspace": "/home/developer/workspace",
      "runtime": "/home/developer/.local/share/mise/shims/node",
      "required": ["github", "vault", "t3", "toolchain"]
    }
  ]
}
```

- `id`: unique lowercase name, up to 63 characters; 1–64 nodes per roster.
- `ssh`: existing alias/hostname. Put User, Port, IdentityFile, ProxyJump and
  keychain configuration in normal SSH config. user@host/IPv6 should use aliases.
- `workspace`: absolute POSIX checkout path. Spaces/apostrophes work; relative
  paths, tilde expansion and control characters are rejected.
- `runtime`: optional absolute Node/Bun executable or mise shim. Defaults to `node` on
  the **non-login SSH PATH**. Configure explicitly when GUI terminals work but SSH
  cannot find Node. A shim also needs mise's environment/PATH working.
- `required`: `github`, `vault`, `t3`, `vscode`, `toolchain`. Defaults to all except
  vscode. Set vscode on editor/manager machines, not just on headless targets.
  `[]` still checks checkout/dependencies/SSH. Unknown fields fail closed.

The manager reference defaults to where the CLI runs from: the published
package, or the dev-fleet checkout a source run is started in. `--workspace PATH`
changes that reference/local sync target. Nodes are compared to **that checkout**,
including uncommitted lockfile edits, not an implicitly fetched origin/main.
Manager capabilities default to all five; headless managers can pass
`--require github,vault,t3,toolchain` or `--require none`. This does not override
remote nodes' required lists. Run `fleet-nodes --schema` for editor/agent validation.

## Evidence and diagnosis

| Check                                                                              | Evidence / next action                                                                                                                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`, `git:clean`                                                           | HEAD, input availability and dirty-tree status; no paths/diffs/file contents logged.                                                                                  |
| `revision`, `sync:*`                                                               | Compare exact HEAD and SHA-256 of package.json, bun.lock, mise.toml, mise.lock against manager. Missing inputs never pass.                                            |
| `dependencies`                                                                     | Last successful fleet frozen-sync receipt matches input hashes. Missing receipt is unverified, not in-sync.                                                           |
| `auth:toolchain`                                                                   | Existing bootstrap/doctor.ts runs in the node checkout with its Bun, bounded to 90s. Run `bun bootstrap/doctor.ts --json` in the node's checkout for individual pins. |
| `ssh:agent`                                                                        | Manager agent exposes an identity; missing agent warns because IdentityFile keys may still work.                                                                      |
| `ssh:session`                                                                      | Fresh batch SSH session actually runs the Node/Bun probe. No reused multiplexed connection or agent forwarding.                                                       |
| `ssh:host-key`, `ssh:dns`, `ssh:auth`, `ssh:network`, `ssh:runtime`, `ssh:timeout` | Classified failure and targeted remedy, without raw logs.                                                                                                             |
| `auth:github`                                                                      | gh auth status --active succeeds; the `github:*` checks ([GitHub](github.md)) say which login, token, permissions and expiry.                                         |
| `auth:vault`                                                                       | Server-side vault token lookup succeeds in this context; not proof of access to every secret path.                                                                    |
| `auth:vscode`                                                                      | code CLI finds the local Remote-SSH extension. Other profiles/Cursor/GUI PATH/agents can differ.                                                                      |
| `t3:settings`                                                                      | Connect explicitly enabled and not revoked in t3 status --json; settings are not connectivity.                                                                        |
| `t3:api`                                                                           | Read-only t3 environment list --json succeeds against the local API; no pairing/token minting.                                                                        |
| `t3:end-to-end`, `vscode:forwarding`                                               | SKIP: actual relay/peer authorization and VS Code tunnel/server installation require operator testing.                                                                |

### Machine health

| Check                        | Evidence / next action                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker:capacity:inodes`     | Free inodes on the home filesystem, against `inodeWarnFreePercent`/`inodeFailFreePercent` in `ansible/ubuntu/policy.json`. The disk guard and disk collector act on the same floors.                                                                                                                                                               |
| `worker:clock`               | `timedatectl` says the clock is synchronised and a time service is enabled; with a reference time, the offset is held to `clock` in the policy.                                                                                                                                                                                                    |
| `worker:reboot-pending`      | `/var/run/reboot-required` exists: warns with its age, fails after `rebootPendingFailDays`. Reboot when no agent turn is running.                                                                                                                                                                                                                  |
| `tailscale:key-expiry`       | The node key expiry Tailscale reports: warns 14 days ahead, fails 3 days ahead. See [Tailscale key expiry](#tailscale-key-expiry).                                                                                                                                                                                                                 |
| `manager:release`            | `sw_vers` against `minimumMajorVersion` in `ansible/macos/policy.json`.                                                                                                                                                                                                                                                                            |
| `manager:updates`            | `softwareupdate --list --no-scan` (nothing is downloaded): warns on pending updates, and names one that waits for a restart. Names never shown.                                                                                                                                                                                                    |
| `manager:disk`               | Free space on the data volume and the space Docker holds, against `disk` in `ansible/macos/policy.json`.                                                                                                                                                                                                                                           |
| `manager:container-watchdog` | The container watchdog (`ansible/monitoring/container-watchdog.py`, a launch agent `hub-darwin.yml` installs) restarts a labelled container that was unhealthy for `unhealthyChecks` runs, at most `maxRestartsPerHour` times an hour (`containerWatchdog` in `ansible/macos/policy.json`). Warns after a restart; fails once it stops restarting. |

### Tailscale key expiry

A node drops off the tailnet on the day its key expires. Keep workers from
expiring: tag them, or disable key expiry for each in the Tailscale admin
console (tagged nodes do not expire). `tailscale:key-expiry` warns two weeks
ahead and fails three days ahead.

With `tailnet` in `fleet.json` and the secret `tailnet-admin`, nothing needs
renewing: every worker joins with a key that carries the fleet's tag, and a
tagged device has key expiry disabled on the hosted Tailscale. For an enrolled
worker whose key still expires (one that joined before it was tagged),
`fleet-sync` disables expiry through the control plane
(`tailscale:key-expiry-policy`); `tailscale:key-expiry` measures the result on
the next run. Headscale gives a node registered with a pre-authorised key no
expiry.

### Maintenance reboots

Kernel and library updates apply only after a reboot (`worker:reboot-pending`).
`devfleet fleet-sync --maintenance-reboot` reboots each worker that has one
pending: one at a time, the canary first, only while it runs no agent turn
(`--force` ends them), through `ansible/ubuntu/reboot.yml`. Each worker is
converged again once it answers; a worker that does not come back ready stops
the ones after it. A new worker that was never ready is rebooted once after its
first converge in any `fleet-sync`, so it reaches ready in one run; a worker
that was ready before is rebooted only by `--maintenance-reboot`.

To re-join a worker whose key expired, a person signs it in again, because
only a person's identity can authorise a device:

1. On the worker's console, run `sudo tailscale up` and open the link it
   prints, signed in to the fleet's tailnet.
2. In the admin console, disable key expiry for the worker, or tag it.
3. From the manager, run `devfleet fleet-sync`: `ansible/ubuntu/tailscale.yml`
   verifies the login and `tailscale:key-expiry` passes.

An SSH shell is not proof that VS Code or T3 Connect works. Diagnostics check
**directed manager → node** connectivity, not all pairs. Run from each intended
manager to check reverse directions. No host-key acceptance, known_hosts edits,
sshd changes, agent forwarding, password retries or credential copying happen.
SSH config/executables/hosts are trusted operator inputs; configured ProxyCommand
or Match commands can execute the operator's own code.

Fingerprints also cover all flat workspace package manifests and the files under
`.mise/locks`, so uncommitted dependency/sidecar edits cannot hide behind an
unchanged root lockfile. Missing/unreadable inputs cannot prove synchronization.

The receipt (`node_modules/.fleet-sync.json`) is historical evidence of completed
frozen setup, **not a full integrity audit**. Manual node_modules edits/deletions
can invalidate that assumption; resync when in doubt. Native package builds still
need normal repository validation. A green install is not a healthy fleet.

## Add a computer

1. Review and run the shared [machine bootstrap](../bootstrap/bootstrap.sh) on
   the new machine. Reopen terminal/editor. Do not invent a second installer.
2. As operator, enable OS SSH access on a trusted private network. Generate a
   distinct machine key, authorize only its public key and verify the server
   fingerprint out of band. Never expose public SSH or copy private keys/auth
   folders. Cloud provisioning remains an OpenTofu task.
3. Configure the manager's SSH alias, append the node to the local roster,
   then run `fleet-nodes` and `fleet-nodes --onboard --node ID --json`. Onboarding
   emits a ready-to-edit SSH stanza, VS Code settings and ordered instructions;
   it does not overwrite user config. Test `ssh ALIAS` manually first.
4. Ensure noninteractive shell startup is quiet and Node (or explicit Bun runtime) is reachable. Fleet
   bundles/streams its own dependency-free probe over stdin: the remote computer
   needs Node or Bun, **not a matching installation of this package** or its dependencies.
5. Authenticate separately: GitHub, Git SSH, Vault, coding providers and T3 pairing
   are distinct sessions. Use gh auth login/setup-git, approved vault login and
   operator-driven t3 up --connect as needed. Never put secrets in reports.
   Workstation and provider configuration are applied by `devfleet fleet-sync`.
6. In VS Code's local profile install Remote-SSH, select the same SSH binary,
   alias/config, enable its login terminal temporarily and inspect Output →
   Remote - SSH. Restart after PATH/agent changes. Check disk space, remote
   server prerequisites and TCP forwarding policy. Onboarding includes a
   loopback-only forwarding test against a known service, not a public listener.
7. Run doctor, review remedies and explicitly sync if needed. Actually open the
   remote workspace in VS Code and test the linked peer in T3 Settings →
   Connections. These are the end-to-end acceptance gates.

Remote nodes require macOS/Linux/WSL and a **POSIX SSH shell**. Native Windows
supports local commands/diagnostics; use a WSL SSH endpoint for remote checks.
Fleet does not guess cmd.exe/PowerShell quoting. Use the existing native Windows
bootstrap and run local reports when a WSL endpoint is unavailable.

## Explicit sync

`sync` is a plan unless **both --apply --yes** are present. Selected nodes apply
serially; diagnostics run at most four remote probes concurrently.

- `--pull` requires a clean attached branch, then runs git pull --ff-only against
  its upstream. No stash/reset/force/rebase/discard. Without it, the branch stays.
- Invalidate the old receipt, then delegate to
  `mise exec --locked bun -- bun bootstrap/setup.ts --non-interactive`.
  This existing owner installs locked tools, publishes user mise config, sets
  shell PATH and installs frozen Bun dependencies. Review OS-specific effects
  and existing config conflict guards in the shared bootstrap runbook.
- Record input hashes only after success and stable checkout inputs. Failed
  setup can leave partial installs, which the next sync completes. Going back
  is `fleet-sync --rollback`, as the [README](../README.md#the-version) says. Trusted checkout
  package lifecycle scripts can execute during installation.
- No other application repos, credentials, provider settings or cloud resources
  are synchronized. `devfleet fleet-sync` remains the broader convergence.
- Run doctor again afterward; successful sync does not prove connectivity/auth.

Subprocesses have deadlines and a combined 1 MiB output cap. SSH probes default
to 120s per node; --timeout MS allows 1s–30m. Applied sync defaults to a 25m SSH
envelope and 20m setup deadline. A killed/disconnected SSH session does **not**
guarantee remote installers stop: inspect the node before retrying. POSIX local
subprocess groups are killed at their deadline.

## Agent contract

`--json` emits one versioned document on stdout, with no progress/auth/child
output. Bun's script runner may print its command to stderr. Reports have
`version: 1`, command, ok, generatedAt, nodes and pass/warn/fail/skip counts.
Node checks have stable id, status, safe summary and optional remedy.action;
snapshots include platform and revision/hash fingerprints. Preserve skips and
warnings: neither is a pass. A plan is not completed work.

Exit 0: no failing checks (warnings/skips remain visible). Exit 1: health or
operation failure. Exit 2: usage/config error. `doctor --strict` also fails on
warnings/skips, including intentional end-to-end skips: it is a **coverage gate**,
not a way to certify the whole fleet from one shell. Usage errors use
`code: invalid_usage`; unexpected errors use `operation_failed` without exposing
exception strings. Fleet never prompts; --non-interactive is accepted.

No telemetry or report file is written automatically. Reports still contain
aliases/hashes: review before sharing publicly. Do not schedule automatic
sync/repairs.

## Notifications and the heartbeat

`devfleet fleet-watch` runs `fleet-status --workers`, compares the result with
the previous run and notifies only when a worker changes between ready and
degraded, and again every `repeatHours` (default 24) while it stays degraded.
Name the targets in `fleet.json`; the address of each is a secret, read through
the secret provider like any other:

```json
"notify": { "targets": ["webhook", "ntfy"], "repeatHours": 24 }
```

| Target    | Secret               | What is sent                                                         |
| --------- | -------------------- | -------------------------------------------------------------------- |
| `webhook` | `notify-webhook-url` | A JSON POST: `source`, `event`, `node`, `checks` (check IDs), `text` |
| `ntfy`    | `notify-ntfy-url`    | A text POST to the topic URL                                         |

A notification carries node and check IDs only. `devfleet fleet-watch --test`
sends one test notification to every target.

Every run stores what it saw, and when, as `watch.json` beside the fleet state
in the bucket. That time is the manager's heartbeat. Nobody has to run it:
`fleet-sync` installs it on the manager as the launchd job
`dev.devfleet.fleet-watch` (`ansible/macos/manager.yml`), which runs every
`manager.schedule.watchMinutes` minutes of `fleet.json` (15 by default) from
the checkout `fleet-sync` last applied, and `manager:watch` fails when it is
not loaded. It reads the bucket credentials `fleet-state --init` saved.

A watcher on the manager notices nothing when the manager itself is off, so
call the reusable `fleet-heartbeat.yml` workflow from the repository that
holds your `fleet.json` (its header shows the one `uses:` line): it fails, and
GitHub notifies you, when the heartbeat is older than `max-age-minutes`
(60 by default). With the watch job every 15 minutes and the workflow every
30, a manager that is turned off fails the workflow within about 90 minutes
(the age limit plus one interval of the workflow's schedule; GitHub may delay
a scheduled run). Keep `max-age-minutes` well above `watchMinutes`.

The CLI proxy is checked off the manager the same way:
`.github/workflows/cliproxy-health.yml` is a reusable workflow, called with one
`uses:` line. It needs no stored secret: it reads the Vault address and the
proxy endpoint from your `fleet.json`, logs in to Vault with GitHub's OIDC
token (the read-only role `vault-role` names, `github-actions` by default) and
runs the checks of the dev-fleet release your `package.json` pins. Copy
[`cliproxy/docs/health-workflow.example.yml`](../cliproxy/docs/health-workflow.example.yml)
into `.github/workflows/` and name the release tag in its `uses:` line; it
runs the free readiness check every 15 minutes, a light inference check hourly
and the full suite nightly, and keeps one tracking issue in your repository.

### The logs of the manager's scheduled jobs

`fleet-sync --schedule` and the watch job write to
`~/.local/share/personal/fleet/manager/logs/<label>.{out,err}.log`. newsyslog
rotates each once it passes `jobLogs.maxKiB` of `ansible/macos/policy.json`
(1024 KiB) and keeps `jobLogs.keep` compressed archives, from the drop-in
`/etc/newsyslog.d/dev-fleet-USER.conf` that the manager's one administrator
grant (`ansible/macos/manager-privilege.yml`) installs. `manager:job-logs`
warns when the drop-in is missing, or a log has grown past twice that size.

`bun run health` remains the separate single read-only **cloud platform**
report.

## Development

```sh
bun run tc
bun run lint
bun test
```

Tests inject results/use temporary fixtures; they do not contact nodes, login or
change global config. The transport smoke test runs the bundled probe locally
against a temporary checkout, not an SSH server.

## Tailscale fleet-status --tailnet in the public CLI

`devfleet fleet-discover --json` lists computers visible to the local signed-in
Tailscale daemon, including offline devices, while explicitly excluding iOS,
Android and tvOS. `devfleet fleet-status --tailnet --json` checks them all and reports
unregistered/ambiguous computers and registered nodes missing from the inventory.
Register actual SSH aliases and checkout paths; the checker does not guess them.
Existing verified-host-key SSH policy and bounded probes apply. Tailscale daemon
health errors invalidate complete discovery. ACL-hidden devices cannot be certified.

Health probes each registered remote node's declared `required` capabilities; it
no longer adds cloud-service logins or direct provider authentication implicitly.
The manager default covers T3, toolchain and workstation configuration.
Explicit `services` requirements retain Railway, Vercel, Cloudflare, AWS and npm
checks. No raw account/auth output is retained. Version checks keep
per-tool results, including the expected pinned version when available, and require
Docker Engine/Compose/Buildx readiness. `workstation` delegates to read-only
the checkout's `bootstrap/doctor.ts --json`; provider configuration presence is not live
authorization. Warnings/skips fail the strict whole-tailnet health coverage gate.

## Repair planning and shared access

The public CLI exposes `devfleet fleet-repair --list` (static catalog) and
`devfleet fleet-repair` (read-only inspection/plan by default). The repair library
in this package only executes allowlisted existing owner commands. Native
account logins and unknown/manual checks always remain operator steps.

Every check ID has an owner in `src/check-owners.ts`: a recipe, or the reason
only a person can repair it, which the plan prints beside the check
(`manual`). Machine repairs are one tag of a playbook the worker already
applies: `recovery` (`worker:service-recovery`), `disk`
(`worker:capacity:*`), `monitoring` (the Beszel agent) and `network` (the
Tailscale daemon). `state:*` checks take the fleet state from the bucket
again. A feature fails when a check is reported that has no owner.

Use `--apply --yes` only after review; `--plan-hash` binds application to the
previewed steps, targets and checkout/shared-input fingerprints. The remote
protocol independently requires explicit apply, a supported repair action and
expected input fingerprints. It preserves verified SSH and disables forwarding.
After owner commands, the manager obtains fresh health checks. Successful
installation never substitutes for authentication or resource authorization.

The workstation owner reads permitted shared provider keys from each machine's
existing Vault session. For process-scoped shared secret access, use the existing
`vault` session on that machine with its intended
project/config. Infrastructure, access policy and secret seeding remain owned by
OpenTofu. No OAuth/session/keychain/SSH credential transfer is implemented.

All commands are in the `devfleet` entry point.

## Reviewed workstation configuration rollout

`devfleet fleet-node-sync --revision FULL_SHA --dry-run` previews this node's
reviewed configuration; without `--dry-run` it applies. `devfleet fleet-sync
--revision FULL_SHA` rolls the same reviewed revision out to the enrolled fleet
after approval. The [setup runbook](../agents/setup.md)
covers canaries, offline/partial failures, per-node receipts and rollback. Both
delegate installation to mise and `bootstrap/setup.ts`.
They never reset the developer checkout or transfer credentials. Status delegates
managed-profile drift evidence to the workstation owner; historical rollout receipts
alone are not a live readiness assertion.
