> This document was written for the fleet dev-fleet was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative.

# Declarative remote workers

The public `devfleet` CLI owns two primary operations:

```sh
devfleet fleet-sync
devfleet fleet-status --workers
```

The manager needs Node/npm, Git, SSH, Tailscale, and its own authorized T3 link.
Initially each worker (an Ubuntu release the [support matrix](support-matrix.md)
lists) needs a
designated non-root account, trusted SSH access and administrator authorization. Standard Ubuntu cloud-image users
already commonly have noninteractive sudo; otherwise establish the repository's
`authorize-sudo.sh` policy once during administrator enrollment. Routine commands
never ask for or store an SSH/sudo password. Unknown host keys, a different device
identity, or missing privilege stop with a named action rather than bypassing trust.

Convergence binds one reviewed revision and worker membership. It transfers only
committed Git objects over SSH, bootstraps missing prerequisites, installs the
locked minimal tool profile and frozen dependencies, and applies Fleet's
Ansible policy. Developer checkouts and dirty work stay intact. A published CLI
uses its source provenance; a source project action explicitly selects checkout
HEAD. Private rosters contain connection paths and identities, not weaker policy.

| Requirement                        | Declaration and enforcement                                                                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One consistent dependency set      | `mise.toml` worker profile, `mise.lock`, Ubuntu snapshot/package pins; exact versions and deployed input hashes checked live                                                                                                                                                  |
| Common service access              | Canonical required capabilities; declared GitHub account, worker's own renewable Vault session, authenticated singleton gateway catalog                                                                                                                                       |
| One gateway host                   | The CLI proxy runs only on the manager; ownership/audit/recovery code rejects any install on a worker and missing singleton state                                                                                                                                             |
| T3 connected and persistent        | One pinned T3 process: the desktop app in the auto-login session, or on a headless worker the pinned server as a lingering user unit; enabled/active with restart policy, bounded recovery timer, private endpoint, manager link matched to SSH-observed environment identity |
| No idle sleep and session survival | systemd sleep masks, logind policy, designated-user lingering; running policy and boot timing checked, not inferred from files alone                                                                                                                                          |
| Recovery after power loss          | Required boot services and recovery timers; recognized firmware restore-after-AC settings inspected when exposed (not applicable on a virtual machine); macOS `autorestart` where supported                                                                                   |
| Always-on services                 | `Restart=always` drop-ins for ssh, tailscaled, docker (with `containers`) and beszel-agent (launchd `KeepAlive` on macOS); health requires the running unit to report that policy                                                                                             |
| Central dashboard                  | Pinned Beszel hub on the manager, every worker enrolled with its own token; health verifies hub reachability, registration, connection and fresh samples                                                                                                                      |
| No routine password prompts        | Verified BatchMode SSH, `sudo -n`, source-owned NOPASSWD policy; missing initial authorization is a failure                                                                                                                                                                   |
| Keep service authorization alive   | Native service credentials stay per-node; Vault self-renewal timer and GitHub recovery from authorized Vault credentials; expiring T3 links are reported before expiry                                                                                                        |

## Worker features

What a worker is built with beyond the base is declared in `fleet.json`:
fleet-wide under `worker.features`, or for one worker under its own
`features`. Each block may name a `preset` first; its own fields override
it. A fleet that names no feature gets what every worker had before features
existed.

| Feature      | Values                | Default   | What it decides                                                                                                                                    |
| ------------ | --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `containers` | `true`, `false`       | `true`    | Docker: the Ubuntu packages, `docker.service`, the developer's `docker` group membership, the `docker-cli` tool and the Docker step of the disk GC |
| `session`    | `desktop`, `headless` | `desktop` | How T3 runs: the desktop app in an auto-login graphical session, or the pinned server as a lingering user service with no display manager          |
| `preset`     | `editing`             | none      | `editing`: no containers, a headless session and only the base tools (it adds no tool profile)                                                     |

What each feature installs is listed once, under `features` in
`ansible/ubuntu/policy.json`. A worker without it installs none of it, and its
checks (`worker:package:*`, `worker:service:docker`, `worker:docker-run`,
`tool:docker-cli`) report **not applicable** with the reason. Turning
`containers` off on an existing worker removes what dev-fleet installed for it:
the packages (not purged: images and volumes under `/var/lib/docker` stay
until a person deletes them), the restart drop-in and the developer's group
membership. `fleet-sync --dry-run` lists what each worker will lose (`plan`,
under `removals`), and `worker:features` reports what the run removed and
fails with `WORKER_FEATURE_REMOVAL_INCOMPLETE` while any of it remains. A
headless worker installs no desktop-only package but removes none: a desktop
the machine came with may depend on them.

## The class of a machine

The probe records each worker's class before anything is installed
(`platform:machine-class`): **physical**, **virtual** (systemd-detect-virt
names a hypervisor) or unsupported (a container or WSL2, refused by
`platform:environment`). A virtual machine has no lid, no battery and no
firmware its guest can read, and its provider restarts it after a power loss,
so `worker:power-loss-recovery` and `ubuntu:lid-policy` report **not
applicable**, with the reason and the worker's optional `powerRecoveryNote`
(for example "provider restarts instances"). The sleep masks are still
checked: a guest can be suspended by its own idle policy. On a physical
machine nothing changes. A not-applicable check is counted apart, shown with
its reason in text and in `--json`, and never fails a run, not even with
`--strict`.

## Size

A worker for the editing workload needs at least **2 CPUs, 3584 MiB of memory
(a 4 GiB instance after the kernel takes its share) and a 20480 MiB root
filesystem** (`sizing.minimumWorker` in `ansible/ubuntu/policy.json`). The
probe measures it before anything is installed and refuses a smaller machine
with `WORKER_SIZE_BELOW_MINIMUM` (`platform:worker-size`); the baseline asserts
the same before it installs a package.

These numbers are an **estimate, not a measurement**. They were reasoned from
the parts of a converged editing worker, not measured on one: Ubuntu Server
itself (about 3 to 5 GiB), the base tools of `worker_tools` with the agent
CLIs (about 3 to 4 GiB under `~/.local/share/mise`), the T3 server archive
(under 0.5 GiB), the package cache and journal caps, and a swap file of half
of memory. A tool profile adds its tools (Go, Rust and the JVM each take
gigabytes), and `containers` adds the engine and its images. Measuring each
profile on a converged worker is still to do (#124); until then, size a
worker with room above the minimum.

The disk and memory lines of the worker policy scale with the machine: each
is a share of the root filesystem or of memory between a lower and an upper
bound (`sizing.thresholds`), and the upper bounds are the fixed numbers every
worker had before.

| Line                               | Share         | Lower    | Upper     |
| ---------------------------------- | ------------- | -------- | --------- |
| Swap file (created only when none) | 50% of memory | 1024 MiB | 8192 MiB  |
| Free disk the baseline keeps       | 5% of disk    | 2048 MiB | 4096 MiB  |
| Disk guard floor                   | 3% of disk    | 1024 MiB | 3072 MiB  |
| Disk GC pressure line              | 15% of disk   | 4096 MiB | 15360 MiB |
| `worker:capacity:disk` warns under | 10% of disk   | 3072 MiB | 10240 MiB |
| `worker:capacity:disk` fails under | 2% of disk    | 1024 MiB | 2048 MiB  |

`worker:agent-sessions` reports how many agent sessions run and how many the
memory policy supports at once: the memory user workloads may use (90%), less
what T3 keeps for itself (1536 MiB), in sessions of an estimated 1024 MiB each
(`sizing.agentSessionMiB`, also an estimate). More sessions than that warn
with `AGENT_SESSION_CAPACITY_EXHAUSTED`; each agent is still capped at 30% of
memory, so the largest is stopped under pressure rather than the machine.

## Package pins and security updates

A pin in `ansible/ubuntu/policy.json` is a **minimum**, never a hold. Ubuntu
keeps installing security updates by itself, and a worker is not turned red by
one:

- The Ubuntu baseline installs a pinned package from the snapshot only when it
  is absent or older than its pin, and never downgrades
  (`ansible/ubuntu/tasks/install.yml`; every pinned package, `systemd-oomd`
  included, goes through it).
- What Ubuntu installs unattended is declared in
  `/etc/apt/apt.conf.d/52personal-fleet-unattended-upgrades`: security updates
  only, no automatic reboot, no removals.
- `worker:package:NAME` passes at the pin, **warns** with
  `PACKAGE_NEWER_THAN_PIN` above it, and fails with `PACKAGE_BELOW_PIN` below
  it or when the package is missing. A warning does not block convergence or
  readiness; it says the pin can be raised when the snapshot moves.
- Tailscale follows the same rule: a newer Tailscale is kept; an older one
  stops with `TAILSCALE_UPGRADE_PENDING`, because upgrading an active VPN can
  drop SSH.

A package run cut off by a power loss is finished by the next sync: the
baseline waits for the APT lock, runs `dpkg --configure -a` once (bounded to
ten minutes) and audits again; only a database still inconsistent stops with
`APT_STATE_BROKEN`.

Health does not mutate configuration, renew tokens, log in, install software, or
make billable inference requests. It audits the immutable desired worker deployment,
not an unrelated developer branch. Every declared worker must be enrolled and
reachable. Extra service hosts are listed as outside scope. Required failures,
warnings and unverified checks prevent a ready result; explicitly non-required
checks remain visible without inventing a pass.

The desired fleet contract is stronger than today's live acceptance. A real
power-loss test and firmware/VM-host automatic restart cannot be proved merely by
starting an OS service. Unsupported firmware inspection remains unverified. A
still-running headless `t3code.service` needs a deliberate migration to the
desktop app; convergence preserves active work instead of killing it. External providers can
revoke authorization; renewal is not a substitute for an initially granted,
renewable node identity. Required expired/missing credentials remain failures,
never interactive password prompts or successful receipts.

Cloud resources, Vault roles/policies and secret values remain exclusively owned
by the OpenTofu roots. Worker configuration belongs to Fleet's Ansible policy and
mise. Runtime logins/renewal do not provision cloud resources. Existing SSH keys,
T3 pairing data, provider identities and the gateway's encrypted recovery state
are never cloned from another node.

The normal manager apply flow reports configuration application separately
from readiness and advances the applied-revision receipt only after required
acceptance succeeds. Read the remaining release gates in [ubuntu-sync.md](ubuntu-sync.md)
before treating any release as complete fleet certification.
