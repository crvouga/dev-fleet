> This document was written for the fleet dev-fleet was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative.

# Fleet topology: one manager, many workers

The fleet has exactly two roles, declared in
your project's `fleet.json` (version 3, checked by [the schema](../schema/fleet.schema.json)) and validated by
[`src/definition.ts`](../src/definition.ts):

| Role        | How many    | Machine                               | Holds state | Runs                                                                                     |
| ----------- | ----------- | ------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| **manager** | exactly one | the human's macOS machine (`manager`) | yes         | `fleet-sync`, the T3 desktop that links to every worker, and **every singleton service** |
| **workers** | any         | Linux boxes (`workers`, Ubuntu 26.04) | no          | the T3 desktop app (UI plus server), agent tools, the Beszel agent; clients only         |

## Manager

- A singleton. All control happens from it, by the human: `devfleet fleet-sync`
  converges the manager **locally** first, then each worker over SSH.
  Started on a worker, `fleet-sync` hands the same request to the manager over
  host-key-verified SSH (no agent forwarding, no credentials copied) and prints
  the manager's result; with no SSH route it changes nothing and reports
  `FLEET_NOT_MANAGER` or `FLEET_MANAGER_UNREACHABLE`. The manager runs that
  request from a clean, fleet-owned checkout of the exact revision
  (`bootstrap/fleet-manager-run.sh`, under
  `~/.local/share/personal/fleet/manager-runs`, three most recent kept), so
  fixes in the revision reach the manager without touching the human's
  checkout. The revision must be on the manager or on `origin`.
- It hosts every singleton service. Today that is the CLI proxy
  (`services.proxy`, [`cliproxy`](../cliproxy/README.md))
  and the Beszel hub (`services.monitoring`,
  [`ansible/monitoring`](../ansible/monitoring/README.md)).
  The manager also runs its own Beszel agent, so it is always a system on that
  hub.
  A new singleton service is declared under `services` and placed on the
  manager; it never names a host.
- Workers depend on it, so it never sleeps on AC power
  (`pmset` in `ansible/macos/policy.json`, checked as `manager:power`, applied
  once by an administrator with `ansible/macos/manager.yml`; the failed check
  prints the command). While the
  manager is asleep, closed or offline, workers have no CLI proxy and no
  dashboard; nothing fails over, because a singleton never runs twice.
- Its state (proxy OAuth/runtime state, the hub database) is backed up off the
  machine as each service documents, so a replacement manager restores it
  ([replacing the manager](manager-recovery.md)).

## Workers

- Stateless cattle: turn one off, re-image it or add another at will. A worker
  is declared in `workers`, enrolled once (SSH trust, sudo, its own Vault
  token), and then fully rebuilt by `fleet-sync` from Git and Vault.
- Workers never host a singleton service. The proxy reports any local install
  on a worker as a duplicate owner, and the hub refuses to install anywhere but
  the manager.
- Anything on a worker is disposable: T3 sessions and worktrees, caches,
  checkouts. Durable work lives in Git remotes; credentials come from Vault.
  Work in progress in agent worktrees is pushed to a recovery ref every 15
  minutes; [durability](durability.md) says what a lost machine takes with it.
- The first declared worker is the rollout canary for a revision new to the
  fleet: a failed canary stops promotion to the other workers. Repeating a
  revision that already converged everywhere runs all workers at once.

## Changing the topology

- **Add or replace a worker:** add it to `workers`, enroll it with
  `fleet-sync`, done. Remove it by deleting the entry.
- **Replace the manager:** follow
  [replacing the manager](manager-recovery.md).
