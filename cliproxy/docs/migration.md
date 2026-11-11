# Restore and migration

Exactly one proxy instance runs, on the **manager** (`manager.id` in `fleet.json`). Workers are clients and never host it. Never activate duplicated OAuth or Tailscale identities concurrently. Source code comes from this package at a reviewed Git revision; secrets and state come from Vault and encrypted R2 snapshots.

`INSTALL_ROOT` below is `~/Library/Application Support/cliproxy-fleet` on the manager and `/opt/cliproxy-fleet` on the legacy Linux host. Run every `devfleet cliproxy …` command from a repository checkout on the host named in the step.

## Move the proxy from a Linux worker to the manager

Today the proxy still runs on the worker `worker-one` (legacy systemd, `/opt/cliproxy-fleet`). This one-time, operator-approved move fences that host and recovers its latest checkpoint on the manager `manager-mac`. The acknowledgement flags below are operator fencing, not a distributed lock. Plan a short outage: workers have no proxy between the source stop and the manager health check.

### 1. Prepare the manager (no outage)

On the manager, logged in, on AC power, with Docker Desktop running (enable **Start Docker Desktop when you sign in**):

```bash
cliproxy/scripts/install-dependencies
devfleet cliproxy install --prepare-only --revision HEAD
devfleet cliproxy vault-login
devfleet cliproxy recover
devfleet cliproxy snapshots
```

`install-dependencies` builds the pinned tools directory (mise Python + hash-locked PyYAML, mise `restic`) that the LaunchAgents run with; it never uses sudo or Homebrew. `--prepare-only` creates the worktree and private directories without starting anything. `recover` reads the existing Restic password from Vault and confirms it; it never generates or writes cloud secrets. Do not run `initialize` before recovery.

### 2. Fence the source (outage starts)

On `worker-one`, stop scheduling, drain the dedicated Tailscale Service advertisement, stop and disable the stack, then take the final consistent checkpoint:

```bash
sudo systemctl disable --now cliproxy-backup.timer cliproxy-backup-check.timer cliproxy-gc.timer
devfleet cliproxy drain
devfleet cliproxy stop
sudo systemctl disable cliproxy-fleet.service
devfleet cliproxy backup
devfleet cliproxy snapshots
sudo systemctl disable --now cliproxy-monitor.timer cliproxy-vault-renew.timer
```

An already stopped stack remains stopped after backup. Record the **latest successful snapshot ID** from `/opt/cliproxy-fleet/state/status/backup-success.json`; do not choose an incomplete snapshot from a failed backup. Confirm the fence before continuing:

```bash
systemctl is-active cliproxy-fleet.service   # inactive
systemctl is-enabled cliproxy-fleet.service  # disabled
python3 -B cliproxy/scripts/fleet_sync.py --definition fleet.json \
  --node worker-one --revision "$(git rev-parse HEAD)"   # PROXY_DECOMMISSION_PENDING, not PROXY_DUPLICATE_OWNER
```

Keep the source powered off or fenced until the move is verified or rolled back.

### 3. Recover and start on the manager

On the manager:

```bash
devfleet cliproxy restore-cache --previous-node-stopped
devfleet cliproxy install --revision HEAD
devfleet cliproxy audit
devfleet cliproxy health
devfleet cliproxy activate
devfleet cliproxy public-endpoint verify
python3 -B cliproxy/tests/live.py --endpoint https://cli-proxy.example.com --codex
devfleet cliproxy backup
```

`restore-cache` downloads the latest modern checkpoint, validates it and populates the empty cache without starting services. `install` (never sudo on macOS) regenerates secret caches from Vault, records the user's UID/GID for Compose, links and loads the `dev.devfleet.cliproxy-*` LaunchAgents in `gui/$UID`, and starts the recovered stack; it refuses missing runtime config and stops with `DOCKER_DESKTOP_NOT_RUNNING` if Docker Desktop is down. `audit` must show clean provenance and loaded agents. `activate` resumes the existing `svc:ai-proxy` advertisement from the restored dedicated identity. A restored `state/public-endpoint-enabled` marker starts the public connector automatically; otherwise run `devfleet cliproxy public-endpoint enable` first.

Then confirm the fleet view and clients:

```bash
python3 -B cliproxy/scripts/fleet_sync.py --definition fleet.json \
  --node manager-mac --revision "$(git rev-parse HEAD)"   # ok: true, role manager, backend launchd
```

From each worker, run the client bootstrap's `--validate` and an actual client/tool request through `https://cli-proxy.example.com` and `https://ai-proxy.tail0a1b2c.ts.net`. Remove temporary plaintext restore copies after verification.

### 4. Decommission the source

After the manager has run cleanly through several scheduled backups, retire the old host's installation. It contains private provider/Tailscale state, so remove it rather than leaving it enabled:

```bash
sudo docker compose --project-directory /opt/cliproxy-fleet \
  --profile portable-endpoint --profile public-endpoint down
sudo rm /etc/systemd/system/cliproxy-*.service /etc/systemd/system/cliproxy-*.timer
sudo systemctl daemon-reload
sudo rm -rf /opt/cliproxy-fleet
git worktree prune
```

`fleet_sync.py --node worker-one` then reports `PROXY_CLIENT_ROLE`. Fleet-sync never performs these steps itself.

### Rollback a failed move

1. On the manager, stop and unload it, keeping any newer state:

   ```bash
   devfleet cliproxy drain
   devfleet cliproxy stop
   devfleet cliproxy backup   # only if the manager refreshed credentials or changed config
   for label in fleet monitor vault-renew backup backup-check gc; do
     launchctl bootout "gui/$(id -u)/dev.devfleet.cliproxy-$label"
     launchctl disable "gui/$(id -u)/dev.devfleet.cliproxy-$label"
   done
   ```

   Move `INSTALL_ROOT/state/runtime`, `state/tailscale` and `state/endpoint.json` into a private directory under `INSTALL_ROOT/recovery/`. With the runtime cache gone, `fleet-sync` reports `PROXY_RECOVERY_REQUIRED` and can never restart the manager copy.

2. On the source, if the manager took a newer backup, move the source's `state/runtime`, `state/tailscale` and `state/endpoint.json` aside the same way and run `devfleet cliproxy restore-cache --previous-node-stopped`; otherwise keep the original source state (old OAuth refresh tokens may be invalid after the manager refreshed them).
3. Restart the source with `sudo systemctl enable cliproxy-fleet.service`, `devfleet cliproxy install --revision REV` (the revision it ran before), `devfleet cliproxy activate`, then re-enable its timers with `sudo systemctl enable --now cliproxy-monitor.timer cliproxy-vault-renew.timer cliproxy-backup.timer cliproxy-backup-check.timer cliproxy-gc.timer`.
4. Verify the stable endpoints from fleet clients. Until the move is retried, fleet-sync reports `PROXY_DUPLICATE_OWNER` on the source; that is expected and is never auto-remediated.

## One-command offline recovery

On a host with the tracked package installed and a valid private Vault token, `devfleet cliproxy recover-node NEW_DIRECTORY` builds a complete new cache using fresh Vault secrets and a verified R2 checkpoint. Supply `--vault-token-file FILE` to use an explicit existing login. It refuses existing destinations and never changes or stops the running stack. This is also a safe recovery rehearsal while the manager remains online: the new identity files are never activated. Remove rehearsal caches after inspection, since they contain private credentials.

On a replacement manager without installed tooling, invoke `python3 -B cliproxy/scripts/recover_node.py "$HOME/Library/Application Support/cliproxy-fleet" --vault-token-file FILE` from a full Git clone after `install-dependencies` passes. The destination must not yet exist. After explicitly fencing the old host, `devfleet cliproxy install --revision REV` installs tracked code and activates the recovered cache. This route replaces the separate prepare/login/password/restore steps above when an existing Vault token is already available. It does not obtain a new machine identity or bypass old-node fencing.

## Recovery details

Recovery uses the current trusted Git checkout, validates decrypted data, and preserves the new Vault login and independently recovered Restic password. It never executes backed-up code. To reproduce the original software version, read the recovered checkpoint's `INSTALLATION.json` in an offline restore first and choose that reviewed Git revision instead of HEAD.

`restore-cache` intentionally refuses an existing `runtime`, `tailscale` or endpoint cache. An existing repository pin must match the restored destination. For recovery on the same host, stop the service/agents and move these cache entries to a private rollback directory first. Never move `state/status/operation.lock` while an operation is active. An interrupted recovery leaves `state/recovery-incomplete`; inspect/remove the partial cache before retrying. Keep `state/secrets` (new Vault login/password) and the lock directory intact.

For offline inspection or historical recovery, use `devfleet cliproxy restore SNAPSHOT_ID EMPTY_DIRECTORY`, then `python3 -B INSTALL_ROOT/scripts/restore-verify EMPTY_DIRECTORY`. Modern checkpoints are located automatically despite different source paths. Old snapshots without `CHECKPOINT.json` require the original explicit restored deployment path and manual state recovery. No automatic fallback to an older snapshot occurs when validation fails.

The existing Tailscale Service remains in the cloud. Reuse the restored dedicated identity only while the original is stopped. If a drained identity requires re-advertising, use the pinned Tailscale CLI's `serve advertise` command for `svc:ai-proxy`, then inspect `serve status`. Do not change the manager's ordinary Tailscale identity or assume hostnames transfer. A new tagged identity/service definition requires the platform's OpenTofu-managed enrollment/approval workflow; no cloud provisioning helper exists in this package.

A normal code/image rollback uses `devfleet cliproxy install --rollback`. That restores a recorded Git revision, not application data. For incompatible state migrations, restore a matching pre-upgrade snapshot while stopped.

## Public hostname cutover

The public DNS/tunnel resources remain owned by OpenTofu. A restored `state/public-endpoint-enabled` marker makes service startup fetch the current isolated tunnel credential from Vault and start the connector automatically. The tunnel token itself is excluded from snapshots. If the marker is absent, run `devfleet cliproxy public-endpoint enable` after restoring and stopping the old host. Verify with `devfleet cliproxy public-endpoint verify` and `tests/live.py --endpoint https://cli-proxy.example.com --codex`. Client API and management keys do not change; keep the old host stopped during recovery.
