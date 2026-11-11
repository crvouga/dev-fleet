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
Initially each Ubuntu 26.04 worker (or best-effort macOS 14+ node) needs a
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

| Requirement                        | Declaration and enforcement                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One consistent dependency set      | `mise.toml` worker profile, `mise.lock`, Ubuntu snapshot/package pins; exact versions and deployed input hashes checked live                                                                               |
| Common service access              | Canonical required capabilities; declared GitHub account, worker's own renewable Vault session, authenticated singleton gateway catalog                                                                    |
| One gateway host                   | The CLI proxy runs only on the manager; ownership/audit/recovery code rejects any install on a worker and missing singleton state                                                                          |
| T3 connected and persistent        | Pinned desktop app as the only T3 process, auto-login session unit enabled/active with restart policy, bounded recovery timer, private endpoint, manager link matched to SSH-observed environment identity |
| No idle sleep and session survival | systemd sleep masks, logind policy, designated-user lingering; running policy and boot timing checked, not inferred from files alone                                                                       |
| Recovery after power loss          | Required boot services and recovery timers; recognized firmware restore-after-AC settings inspected when exposed; macOS `autorestart` where supported                                                      |
| Always-on services                 | `Restart=always` drop-ins for ssh, tailscaled, docker and beszel-agent (launchd `KeepAlive` on macOS); health requires the running unit to report that policy                                              |
| Central dashboard                  | Pinned Beszel hub on the manager, every worker enrolled with its own token; health verifies hub reachability, registration, connection and fresh samples                                                   |
| No routine password prompts        | Verified BatchMode SSH, `sudo -n`, source-owned NOPASSWD policy; missing initial authorization is a failure                                                                                                |
| Keep service authorization alive   | Native service credentials stay per-node; Vault self-renewal timer and GitHub recovery from authorized Vault credentials; expiring T3 links are reported before expiry                                     |

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
