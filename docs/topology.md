> This document was written for the fleet dev-fleet was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative.

# Fleet topology: one manager, many workers

The fleet has exactly two roles, declared in
your project's `fleet.json` (version 3, checked by [the schema](../schema/fleet.schema.json)) and validated by
[`src/definition.ts`](../src/definition.ts):

| Role        | How many    | Machine                                        | Holds state | Runs                                                                                     |
| ----------- | ----------- | ---------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| **manager** | exactly one | the human's macOS machine (`manager`)          | yes         | `fleet-sync`, the T3 desktop that links to every worker, and **every singleton service** |
| **workers** | any         | Linux boxes (`workers`, Ubuntu 26.04 or 24.04) | no          | the T3 desktop app (UI plus server), agent tools, the Beszel agent; clients only         |

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
  (`pmset` in `ansible/macos/policy.json`, checked as `manager:power` and
  applied by `ansible/macos/manager.yml` on every `fleet-sync` once an
  administrator has given the one grant `ansible/macos/manager-privilege.yml`;
  the failed check prints the command, and
  [docs/manager-setup.md](manager-setup.md) lists every step only a person
  takes). While the
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
- One worker is the rollout canary for a revision new to the fleet: the one
  `fleet-sync --canary` or `canary` in `fleet.json` names, else the first
  declared worker. When it cannot be reached (powered off, being rebuilt),
  the next reachable worker in declared order proves the revision instead and
  the unreachable one is reported as offline, never as a blocked rollout. A
  canary that was deployed and failed stops promotion to the other workers.
  Each worker's applied revision is kept in the fleet state, so one that
  converged keeps its progress when another did not. Repeating a revision
  that already converged everywhere runs all workers at once.

## Changing the topology

- **Add or replace a worker:** add it to `workers`, enroll it with
  `fleet-sync`, done. Remove it by deleting the entry.
- **Workers an infrastructure tool creates:** `workerRecords` in `fleet.json`
  names a file (relative to `fleet.json`) or a command that returns worker
  records, the provider-neutral description of a machine in
  [`schema/worker-record.schema.json`](../schema/worker-record.schema.json):
  `id`, `tailnetName` or `address`, `user`, `port`, `hostKey` and optional
  `labels` and `billing`. Their workers join the inline list; dev-fleet only
  reads them and never calls a provider or creates a machine. A record that
  appears is a declared worker, enrolled by the next `fleet-sync`; one that
  disappears (a file that is gone holds none) is retired by the next
  `fleet-sync` exactly as `fleet-node-retire` retires one. A worker listed by
  hand is never retired by itself. An invalid record is refused naming its
  field, such as `$.workerRecords[0].workers[1].hostKey`.
  [`examples/workers-from-infrastructure`](../examples/workers-from-infrastructure/main.tf)
  shows the handoff with a local virtual machine, the seed going in and the
  record coming out. The canary stays the one `canary` names, so the order
  of generated records means nothing.
- **Replace or retire a worker:** `fleet-node-replace` and `fleet-node-retire`
  take everything of the old machine with it: its pinned host key, its
  monitoring system (pointed at the new machine, or deleted), the manager's
  T3 link to its environment (the new one is paired in the manager's T3), its
  Vault token and, once the tailnet control is wired, its tailnet device.
  `fleet-status --workers` warns about a monitoring system that matches no
  declared worker (`beszel:leftover`).

## Parked and idle workers

A rented worker costs money while it runs. `devfleet fleet-node-park --id ID`
records in the fleet state that it is stopped or destroyed on purpose: from
then on `fleet-sync` and `fleet-status` list it as parked with the time since
(`worker:parked`, not applicable), never contact it, never make it the
canary, and it never changes an exit code. Parking refuses while agent turns
run on it (`WORKER_BUSY`) unless `--force`. `devfleet fleet-node-resume --id
ID` marks it active and runs `fleet-sync --node ID`, which converges and
verifies it. `parking.stop` and `parking.start` in `fleet.json` name commands
(an infrastructure tool, never a provider dev-fleet calls) run with the worker
ID as their last argument. A parked worker found online on the tailnet is a
warning (`worker:parked-online`); one that comes back as a new machine goes
through `fleet-node-replace`.

`fleet-status` reports, for every worker it reaches, its uptime, the agent
turns under way and the time of the last agent activity, read from what T3
records (status and times, never a session's content), in its text and as
`workers` in its JSON. With `parking.idleAfterHours`, a worker with no agent
activity for longer is `worker:idle` (a warning whose remedy is to park it);
one with a turn under way never is. `billing.hourlyRate` on a worker (or its
record) is only displayed and summed: `usage` says how many workers run, how
many are idle and what the idle ones cost per day. `parking.autoPark: true`
lets `fleet-watch` park idle workers by itself; it is off unless set.

- **Replace the manager:** follow
  [replacing the manager](manager-recovery.md).
