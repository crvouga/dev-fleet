# Beszel owner and recovery

Fleet's [manager guide](../../fleet/docs/ubuntu-sync.md) is the normal entry
point: `devfleet fleet-sync`, run on the manager. Workstation owns the
pinned Compose hub, native agent units and local Ansible tasks here. Fleet owns
membership, registration and freshness evidence. `lock.json` pins Beszel 0.21.1
and the native agent checksums. Never run an unpinned upstream installer
alongside these services.

## Manager and workers

The fleet has exactly two roles (Fleet `definition.json`, version 3):

- **Manager** — the human's macOS machine. It runs fleet-sync locally and hosts the
  singleton hub (`cli/lib/monitoring/manager-hub.ts`, `convergeManagerHub`). Fleet
  keeps it awake on AC power. Nothing is installed on it over SSH.
- **Workers** — the stateless Linux boxes. They only run the native agent
  (`agent.yml`, a hardened systemd unit) and connect to the manager's private hub
  URL. A worker refuses hub mode (`BESZEL_NOT_HUB`: the hub runs only on the
  manager) and an agent refuses any other hub URL (`BESZEL_HUB_MISMATCH`).

The manager is always a monitored system on its own hub. After the hub converges,
fleet-sync enrolls the manager like a worker and installs its agent locally with
`agent-darwin.yml`: the same pinned binary (`lock.json` carries the darwin
checksums) as a per-user launchd agent with `KeepAlive`
(`~/Library/LaunchAgents/dev.devfleet.beszel-agent.plist`, state under
`~/Library/Application Support/personal-beszel-agent`). It needs no sudo, so
fleet-sync stays unattended; it is less sandboxed than the Linux unit. It refuses
to run beside a leftover root LaunchDaemon with the same label
(`BESZEL_LEGACY_DAEMON`).

## Hub on the manager

`hub-darwin.yml` runs as the signed-in user (no sudo) under Docker Desktop, which
must be running (`BESZEL_DOCKER_DESKTOP_REQUIRED`); enable _Start Docker Desktop
when you sign in_. It refuses to replace a different existing image
(`BESZEL_HUB_UPGRADE_PENDING`). Paths are per-user and `0700`:

- data: `~/Library/Application Support/personal-beszel` (bind-mounted as
  `/beszel_data`; it is in the human's normal home backups, but use the stock
  backups below for consistent copies);
- connector token: `~/Library/Application Support/personal-beszel-tunnel/token`
  (`0600`).

The dashboard is `https://<manager-MagicDNS-name>:8443`
(`hubUrl(definition)`), used by agents and checks. CLI output only ever prints
the stable public dashboard, `https://beszel.example.com`; tailnet addresses
are never printed. The Compose port is
loopback-only; Tailscale Serve (`tailscale serve --bg --https=8443
http://127.0.0.1:8090`, using `tailscale` on PATH or the app's
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`) provides private HTTPS.
No Funnel or inbound listener is configured. Convergence passes `beszel:hub` only
after `/api/health` answers both locally and at the private URL. Before enrolling
agents, fleet-sync requires that URL to answer; otherwise workers report
`BESZEL_HUB_UNREACHABLE` (keep the manager awake and Docker Desktop running).

The same hub is also served at `https://beszel.example.com` through an
outbound-only Cloudflare Tunnel: the inventory's
`cloudflare.additional_tunnels.beszel` entry makes OpenTofu own the tunnel, its
proxied DNS record and the isolated `secret/beszel/tunnel` Vault document. The
hub converge reads that document with the manager's own Vault session (the
human's session; never printed or placed in argv), writes it to the per-user
token file and starts the pinned `cloudflared` Compose profile. Until the
credential is readable the step warns (`BESZEL_TUNNEL_CREDENTIAL_UNAVAILABLE`)
and the private dashboard is unaffected. Agents and the manager keep using the
private URL; `fleet-status --workers` reports the public hostname as a
warning-level `beszel:public-endpoint` check.

The dashboard needs no login: the hub runs with `AUTO_LOGIN` set to the
read-only user `public-viewer@example.com`, so every visitor (public or
tailnet) is signed in as that account and cannot change systems, alerts or
settings. Each hub converge (`fleet-sync`) creates that user through the hub's
loopback API using the fleet admin login from Vault (random unused password,
never printed), re-reads it to prove the role, and demotes it to read-only if it
ever had another role (`beszel:public-viewer`). If the admin login is
unavailable the step warns and the hub shows its normal login page; create the
user by hand (Settings > Users, role **Read-only**) as a fallback. Never point
`AUTO_LOGIN` at an admin account. The fleet admin login is still needed to change anything.

Native agents use outbound authenticated WebSockets, per-node tokens and
persistent identity. They do not need inbound SSH monitoring ports, Docker socket
access or journals.
`SKIP_SYSTEMD_LOGS=true` deliberately excludes potentially sensitive service logs.
System services may be visible; user T3 service information is not certified by
that fact. Missing sensors, SMART privileges, Docker stats and user-service metrics
remain unavailable until their specific supported permissions are reviewed.

Accounts need no manual step. On a hub's first start (empty data directory),
`hub-darwin.yml` passes Beszel's `USER_EMAIL`/`USER_PASSWORD` once, so the hub
creates `fleet-manager@example.com` as a verified user and as its superuser,
with the password OpenTofu generates as `BESZEL_FLEET_AUTH` in
`secret/personal/prd`. Later runs never pass it, and existing data is never
changed. Sign in to the dashboard with that account.
The hub runs with `SHARE_ALL_SYSTEMS=true`, so systems that account registers are
visible to every hub login.
A legacy JSON `identity`/`password` value is still accepted. The manager's existing
Vault credential must renew unattended. Superuser credentials are not distributed
to nodes or needed for enrollment. Revocation produces action-required results.

Configure network monitors and alert thresholds once in the stock UI; these
settings are runtime application data, preserved in backups. Select explicit probe
origins rather than an all-to-all mesh. Use sustained resource-pressure alerts,
disk capacity, offline nodes and supported temperatures. Do not send notifications
until an authorized destination exists. Service-failure alert delivery has not
been accepted against this pinned release.

## Stock backup and restore

1. Open the hub's private PocketBase administration route `/_/` and authenticate
   as its superuser. Keep that credential separate from fleet enrollment access.
2. Open **Settings → Backups**. Create and download a backup before maintenance.
   Set scheduled backups and retention there using existing authorized storage.
   Do not provision a bucket or reuse unrelated credentials to bypass access gates.
3. Protect downloaded archives as secrets: they contain registrations, tokens,
   account data, alert configuration and history. Use the existing approved
   encrypted backup destination; a backup on the same disk is not disaster recovery.
4. Restore the archive into an isolated instance of the same pinned release with
   outbound agent connections blocked. Use the stock upload/restore action, never
   database edits. Restoring restarts the hub. Verify original node IDs, fingerprints,
   history and settings before selecting a replacement host. Fence the old hub
   before production recovery; never operate two copies of its identity.
5. Run the manager command and require new metric timestamps after recovery.
   Old historical samples do not prove agent connectivity.

## Moving the hub to the manager

The hub previously ran on worker `worker-one` (`/var/lib/personal-beszel`,
Compose project `personal-beszel`). Move it once, as an operator, in this order;
never run two copies of its identity or two tunnel connectors:

1. On the old hub host, create and download a stock backup (**Settings → Backups**) and keep
   it as a secret.
2. Fence the old hub on that host: `sudo docker compose -p personal-beszel down`
   (stops the hub and its `cloudflared` connector; keep `/var/lib/personal-beszel`
   untouched until the move is verified), then
   `sudo tailscale serve --https=8443 off`.
3. On the manager, with Docker Desktop running, run fleet-sync. It starts a fresh
   hub, which creates the fleet account itself, and enrolls every worker. To keep
   history instead, restore the backup afterwards through the stock **Backups**
   upload/restore action as the superuser.
4. Confirm fresh samples from every worker in the dashboard.
5. Only after verification, remove the old host's hub data and its `beszel-hub-read`
   Vault grant (OpenTofu).

`tests/upstream.py` exercises real pinned binaries with disposable loopback data:
authenticated registration, fresh metrics, restart identity preservation, no duplicate
record, and the supported PocketBase backup/restore API. It does not contact live
nodes, prove Tailscale routing, verify systemd reboot, or test an off-host encrypted
backup destination. Those remain explicit release/operational gates.

References: [agent](https://beszel.dev/guide/agent-installation),
[systemd](https://beszel.dev/guide/systemd),
[network monitors](https://beszel.dev/guide/network-monitors),
[backup API](https://pocketbase.io/docs/api-backups/).
