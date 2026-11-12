# Replacing the manager

This is the one runbook for a manager that is replaced or lost: stolen, a dead
disk, or a new machine. Other documents link here and do not describe the
procedure themselves.

## What must exist off the machine

Nothing on the old manager is needed. Before you need this runbook, make sure
these exist elsewhere:

| What                                | Where                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Your project: `fleet.json`, the pin | Its Git remote                                                           |
| The fleet state                     | The bucket `fleet.json` names under `state`                              |
| The bucket's two credentials        | Your password manager (never the manager alone)                          |
| Secrets                             | Your `secrets` provider; `file` and `env` secrets must be kept elsewhere |
| The CLI proxy's encrypted snapshots | Its restic repository (`vault` secrets provider only)                    |
| Your Tailscale and Docker accounts  | Yours: signing in is the only step only you can do                       |

## Restore

On the new machine, with Git, Node and Docker installed:

1. Give it the manager's local host name: `manager.id` in `fleet.json`
   (`sudo scutil --set LocalHostName ID` on macOS). `fleet-sync` refuses to
   run on any other machine.
2. Sign in to Tailscale and approve the device. Sign in to Docker Desktop if
   your plan needs it.
3. Fetch the project and check every prerequisite. Nothing is changed:

   ```sh
   git clone YOUR-PROJECT && cd YOUR-PROJECT && npm ci
   export DEVFLEET_BUCKET_ACCESS_KEY_ID=… DEVFLEET_BUCKET_SECRET_ACCESS_KEY=…
   npx devfleet fleet-restore --dry-run
   ```

   It fails on anything missing (`restore:*` checks, each with its remedy)
   and lists what will be restored, in order.

4. Restore, then converge:

   ```sh
   npx devfleet fleet-restore              # the fleet state, from the bucket
   npx devfleet fleet-sync --take-over     # the manager, then every worker
   npx devfleet fleet-state --init         # credentials for runs the manager starts itself
   npx devfleet cliproxy install           # the proxy, from its snapshots
   ```

   The proxy's own steps are in [its migration runbook](../cliproxy/docs/migration.md).
   `--take-over` is needed while the old manager's lease runs (seven days
   after its last change). Use it only once the old machine is gone: an old
   manager that wakes up afterwards is refused with `FLEET_MANAGER_LEASE_HELD`.

5. Adopt the T3 instances again: `npx devfleet t3-apply --import ID`.

Workers need nothing: they reach the manager by its Tailscale name, so they
follow it once the new machine holds that name. If the Tailscale name
changed, change `manager.network.tailscaleName` in `fleet.json` and run
`fleet-sync`, which re-points every worker.

## What is lost

The monitoring hub's metric history, alerts and settings made by hand. Its
accounts and systems are recreated. With `env` or `file` secrets, whatever
was only on the old manager.

## Coming back by itself

A manager restarts after a power cut only when it is set up to
(`manager:boot-recovery` in `fleet-status`): `autorestart` and Docker Desktop
at login are applied by `ansible/macos/manager.yml`. The per-user services
need a user session. **With FileVault on, a Mac waits at the login window
after every restart until a person signs in**, so nothing comes back
unattended. That is the trade-off: FileVault protects the proxy's logins and
the bucket credentials on a stolen Mac; automatic login without FileVault
lets the fleet recover from a power cut alone. `fleet-status` reports
FileVault as a warning with that consequence; the choice is yours.
