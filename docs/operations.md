> This document was written for the fleet dev-fleet was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative.

# Developer fleet

`@pkgs/fleet` diagnoses development computers: SSH, VS Code Remote-SSH,
per-machine authentication, T3 Connect and shared toolchain/dependency drift.
It is a local CLI/library, not a daemon or cloud manager. It reuses the
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
Workers are Ubuntu 26.04; the manager is macOS and never sleeps on AC power
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

This private package exposes a TypeScript API from `@pkgs/fleet`; the public
executable is `personal` (`bun run personal` from the checkout). Schema, roster
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
  "$schema": "./packages/fleet/schema.json",
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

| Check                                                                              | Evidence / next action                                                                                                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`, `git:clean`                                                           | HEAD, input availability and dirty-tree status; no paths/diffs/file contents logged.                                                                  |
| `revision`, `sync:*`                                                               | Compare exact HEAD and SHA-256 of package.json, bun.lock, mise.toml, mise.lock against manager. Missing inputs never pass.                            |
| `dependencies`                                                                     | Last successful fleet frozen-sync receipt matches input hashes. Missing receipt is unverified, not in-sync.                                           |
| `auth:toolchain`                                                                   | Existing bootstrap/doctor.ts runs in the node checkout with its Bun, bounded to 90s. Use personal workstation tools check --json for individual pins. |
| `ssh:agent`                                                                        | Manager agent exposes an identity; missing agent warns because IdentityFile keys may still work.                                                      |
| `ssh:session`                                                                      | Fresh batch SSH session actually runs the Node/Bun probe. No reused multiplexed connection or agent forwarding.                                       |
| `ssh:host-key`, `ssh:dns`, `ssh:auth`, `ssh:network`, `ssh:runtime`, `ssh:timeout` | Classified failure and targeted remedy, without raw logs.                                                                                             |
| `auth:github`                                                                      | gh auth status --active succeeds on this machine; not proof of Git SSH or every repository permission.                                                |
| `auth:vault`                                                                       | Server-side vault token lookup succeeds in this context; not proof of access to every secret path.                                                    |
| `auth:vscode`                                                                      | code CLI finds the local Remote-SSH extension. Other profiles/Cursor/GUI PATH/agents can differ.                                                      |
| `t3:settings`                                                                      | Connect explicitly enabled and not revoked in t3 status --json; settings are not connectivity.                                                        |
| `t3:api`                                                                           | Read-only t3 environment list --json succeeds against the local API; no pairing/token minting.                                                        |
| `t3:end-to-end`, `vscode:forwarding`                                               | SKIP: actual relay/peer authorization and VS Code tunnel/server installation require operator testing.                                                |

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
   Workstation/provider configuration remains an explicit `personal workstation sync` operation.
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
  setup can leave partial installs; no rollback is claimed. Trusted checkout
  package lifecycle scripts can execute during installation.
- No other application repos, credentials, provider settings or cloud resources
  are synchronized. `personal workstation update`/`personal workstation sync` remain explicit broader convergence.
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
aliases/hashes: review before sharing publicly. For monitoring, schedule read-only
`devfleet fleet-status --json` in your existing task runner and alert on exit 1/2;
do not schedule automatic sync/repairs. `bun run health` remains the separate
single read-only **cloud platform** report.

## Development

```sh
bun run --cwd packages/fleet tc
bun run --cwd packages/fleet lint
bun run --cwd packages/fleet test
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
`personal workstation doctor --json --non-interactive`; provider configuration presence is not live
authorization. Warnings/skips fail the strict whole-tailnet health coverage gate.

## Repair planning and shared access

The public CLI exposes `devfleet fleet-repair --list` (static catalog) and
`devfleet fleet-repair` (read-only inspection/plan by default). The repair library
in this package only executes allowlisted existing owner commands. Native
account logins and unknown/manual checks always remain operator steps.

Use `--apply --yes` only after review; `--plan-hash` binds application to the
previewed steps, targets and checkout/shared-input fingerprints. The remote
protocol independently requires explicit apply, a supported repair action and
expected input fingerprints. It preserves verified SSH and disables forwarding.
After owner commands, the manager obtains fresh health checks. Successful
installation never substitutes for authentication or resource authorization.

The workstation owner reads permitted shared provider keys from each machine's
existing Vault session. For process-scoped shared secret access, use the existing
`personal infra-vault run --config dev -- COMMAND` workflow on that machine with its intended
project/config. Infrastructure, access policy and secret seeding remain owned by
OpenTofu. No OAuth/session/keychain/SSH credential transfer is implemented.

All commands are in the `devfleet` entry point.

## Reviewed workstation configuration rollout

`devfleet fleet-node-sync --revision FULL_SHA --dry-run` previews this node's
reviewed configuration; without `--dry-run` it applies. `devfleet fleet-sync
--revision FULL_SHA` rolls the same reviewed revision out to the enrolled fleet
after approval. The [setup runbook](../agents/setup.md)
covers canaries, offline/partial failures, per-node receipts and rollback. Both
delegate rendering to personal workstation and installation to existing mise/bootstrap.
They never reset the developer checkout or transfer credentials. Status delegates
managed-profile drift evidence to the workstation owner; historical rollout receipts
alone are not a live readiness assertion.
