# Set up a fleet from your own project

This is the whole procedure for connecting dev-fleet to your own machines,
written so a coding agent can do it in one pass from the project that will hold
the fleet configuration. It assumes nothing about your accounts, hosts or
domains: every value below in `UPPER_CASE` or under `example.com` is a
placeholder you replace.

If you are an agent, read the [rules](#rules-for-agents) first, then follow
the steps in order. Stop and ask the human only at the points marked **Ask**.

## What you end up with

```
your-fleet/                 any Git repository you own (it may hold other things too)
  package.json              pins @crvouga/dev-fleet to one exact version
  package-lock.json         or bun.lock, pnpm-lock.yaml: commit it
  fleet.json                your machines, services, secrets locations, state bucket
  .gitignore                keeps credentials and node_modules out of Git
  AGENTS.md                 tells future agents how to use dev-fleet here
```

Nothing else is needed. You never clone dev-fleet, copy its files or write a
wrapper script around a checkout of it: the npm package is the tool, and the
version in `package.json` is the commit every machine runs.

| Concept     | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| manager     | The one macOS machine you run `devfleet fleet-sync` on. Hosts the CLI proxy and the monitoring hub.            |
| worker      | An Ubuntu 26.04 or 24.04 machine the manager converges over SSH. Stateless: rebuilt from Git and your secrets. |
| fleet state | One SQLite database (roster, approved revision, configuration last applied) replicated to your bucket.         |
| bucket      | Any S3-compatible bucket you own, or a directory. The source of truth for the fleet state.                     |
| revision    | The dev-fleet commit the installed package was published from (`npx devfleet --version`).                      |

## Rules for agents

- **Do not clone, vendor or patch dev-fleet.** Not `node_modules`, not a
  checkout `fleet-sync` puts on a machine, not a file it manages there. The
  next install or sync replaces them. A bug or a missing feature is an issue
  at <https://github.com/crvouga/dev-fleet/issues>; tell the human what is
  blocked and link it. Issues are public: no credentials, hostnames,
  accounts, domains or `fleet.json` contents.
- **Never put a secret in an argument, in `fleet.json`, in a commit or in a
  log.** Bucket credentials are read only from the environment; every other
  secret from the provider named under `secrets`.
- **Do not bypass SSH host keys, forward SSH agents or copy login caches**
  between machines. Host trust, sudo and sign-ins are the human's steps.
- **Previews are safe; applies are not.** `--dry-run`, `fleet-status`,
  `fleet-state` (without flags) and `commands --json` change nothing.
  `fleet-sync` without `--dry-run` changes every machine.
- **Use the command, never the code.** dev-fleet has no library API: do not
  import anything from `node_modules/@crvouga/dev-fleet/`. The project's own
  tools go in the project's `mise.toml`; the global mise configuration on a
  fleet machine is dev-fleet's.
- **Use JSON.** Every diagnostic command takes `--json` and
  `--non-interactive`. Read the check IDs and `remedy.action` from the
  output; do not parse the human table.
- The machine-readable contract (commands, exit codes, safety rules, how to
  report a bug) is `npx devfleet commands --json`. Read it before running
  anything else.

## 1. Check what the human must already have

These cannot be installed or decided by dev-fleet. Verify each one; for any
that fails, **Ask** the human to do it and wait.

On the manager (the Mac this project is checked out on):

| Requirement                                              | Verify                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| macOS 14 or newer                                        | `sw_vers -productVersion`                                       |
| Git                                                      | `git --version`                                                 |
| Node 22 or newer (for `npx`)                             | `node --version`                                                |
| Docker Desktop running (the proxy and the hub run in it) | `docker info --format '{{.ServerVersion}}'`                     |
| Tailscale signed in                                      | `tailscale status --json` (look for `"BackendState":"Running"`) |
| An SSH alias per worker that works without a prompt      | `ssh -o BatchMode=yes WORKER_ALIAS true` for each worker        |

On every worker, check each row of
[what a machine must offer to be a worker](worker-requirements.md): the
image, architecture and size, the access, the first-boot data and the
network. Each row says how to verify it. If `sudo -n true` fails, that is fine
for the first, interactive run, which asks for the password once and installs
a sudo rule for the fleet; it is not fine for unattended runs.

A worker is reached in one of two ways, always with `BatchMode=yes` and
`StrictHostKeyChecking=yes`; never add `StrictHostKeyChecking=no` or
`accept-new`.

- **From declared data (no alias).** Leave `ssh` out: dev-fleet connects as
  `network.user` on `network.sshPort` to `network.tailscaleName`, and checks
  the host key against a known_hosts file of its own, rendered from the key
  the fleet state pins. The human's `~/.ssh/config` and `~/.ssh/known_hosts`
  are neither needed nor changed. The key is pinned without trusting a first
  connection: `npx devfleet fleet-node-seed --id ID --output PATH --apply
--yes` generates it for a new machine, `npx devfleet fleet-node-replace
--id ID --host-key "TYPE BASE64" --apply --yes` pins one the human verified
  out of band, and a worker record (below) may carry it as `hostKey`.
- **Through the human's own alias.** `ssh` names a Host alias in the
  manager's `~/.ssh/config`, and its host key must already be in their
  `known_hosts`. **Ask** the human to verify each fingerprint out of band and
  connect once by hand. A typical alias:

```
Host worker-one
  HostName worker-one.tail0a1b2c.ts.net
  User dev
```

Also **Ask** for these, which only the human has:

1. **A bucket for the fleet state.** An empty private bucket on any
   S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2, MinIO) and an
   access key that can read and write it: bucket name, endpoint (omit for AWS
   S3), region (`auto` for R2). For a trial, an absolute directory path works
   instead and needs no credentials.
2. **Where secrets are kept**, one of `vault`, `sops`, `file` or `env` (see
   [secrets](#secrets)). With `vault`, the address, the KV v2 mount and the
   path and field of each secret.
3. **The public origins** of the CLI proxy and of the monitoring dashboard,
   and the two monitoring account emails (`services` below). They are
   placeholders until the human has the domains.
4. **The GitHub login** every worker signs in as, and the Vault user name.

## 2. Create the project

```sh
mkdir -p your-fleet && cd your-fleet   # or an existing repository
git init                               # if it is not one yet
npm init -y                            # if there is no package.json yet
npm install --save-dev --save-exact @crvouga/dev-fleet
npx devfleet --version                 # 1.2.3 (commit 3f2a…): the revision every machine will run
```

Pin the exact version (`--save-exact`); a range would let a reinstall move the
whole fleet. Any package manager works (`bun add -d --exact`,
`pnpm add -D --save-exact`). The CLI runs on Bun, which the package brings as
a dependency; if your package manager skips install scripts, allow Bun's or
install Bun yourself.

Add to `.gitignore`:

```gitignore
node_modules/
.env
.env.*
.fleet.local.json
```

## 3. Write `fleet.json`

Start from the example the installed package prints, which points `$schema`
at the schema shipped in the package, so editors validate the file:

```sh
npx devfleet fleet-state --example > fleet.json
```

Then replace every placeholder. Each field, from
[`schema/fleet.schema.json`](../schema/fleet.schema.json):

| Field                                                 | Value                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `version`                                             | `3`                                                                                                                      |
| `source.repository`                                   | `https://github.com/crvouga/dev-fleet.git`, or your fork if you publish one. Machines only accept code from it.          |
| `state`                                               | `{ "bucket", "endpoint"?, "region"?, "prefix"? }` or `{ "directory": "/absolute/path" }`. Never credentials.             |
| `secrets`                                             | See [secrets](#secrets).                                                                                                 |
| `manager.id`                                          | A short lowercase id, `^[a-z][a-z0-9-]{0,62}$`, e.g. `manager-mac`.                                                      |
| `manager.os`                                          | `"macOS"`                                                                                                                |
| `manager.network.tailscaleName`                       | The manager's MagicDNS name: `tailscale status --json` → `.Self.DNSName` without the trailing dot.                       |
| `manager.network.user`                                | The manager's login name (`id -un`).                                                                                     |
| `manager.neverSleepOnPower`                           | `true` (workers depend on the manager's services).                                                                       |
| `workers[].id`                                        | A short lowercase id. The first reachable worker is the canary: a new revision must pass there before the others get it. |
| `canary`                                              | Optional: the id of the worker to prefer as canary. When it is unreachable, the next reachable worker is used.           |
| `workers[].ssh`                                       | The worker's alias in the manager's `~/.ssh/config`.                                                                     |
| `workers[].os`                                        | `"linux"`                                                                                                                |
| `workers[].network.tailscaleName`                     | The worker's MagicDNS name (from `tailscale status --json` → `.Peer[].DNSName` on the manager).                          |
| `workers[].network.sshPort`                           | `22` unless the worker's sshd listens elsewhere.                                                                         |
| `workers[].network.user`                              | The worker account (`ssh WORKER_ALIAS id -un`).                                                                          |
| `workers[].network.t3Port`                            | `3773`                                                                                                                   |
| `services.proxy.endpoint`                             | The public HTTPS origin of the CLI proxy, e.g. `https://cli-proxy.example.com`.                                          |
| `services.monitoring.hubPort`                         | `8443`                                                                                                                   |
| `services.monitoring.publicUrl`                       | The public HTTPS origin of the monitoring dashboard.                                                                     |
| `services.monitoring.managerAccount`                  | The email of the monitoring account the manager enrolls machines with.                                                   |
| `services.monitoring.viewerAccount`                   | The email of the read-only account visitors are signed in as.                                                            |
| `ubuntu`                                              | `{ "release": "26.04", "architectures": ["amd64", "arm64"] }`: a release of the [support matrix](support-matrix.md).     |
| `worker.requiredCapabilities`                         | Normally all of `github`, `vault`, `t3`, `toolchain`, `workstation`, `worker`.                                           |
| `worker.githubLogin`                                  | The GitHub login every worker must be signed in as.                                                                      |
| `github` (optional)                                   | Who the manager signs in to GitHub as, per-node tokens, required scopes; see [GitHub](github.md).                        |
| `worker.vaultUser`                                    | The Vault user each worker's token is issued for.                                                                        |
| `worker.toolchain`, `agentProfile`                    | `"mise.lock"`, `"proxy"` (fixed).                                                                                        |
| `worker.unattendedSudo`, `persistentT3`, `neverSleep` | `true` (fixed policy).                                                                                                   |

Use the same values in every place they repeat. Validate before going on:

```sh
npx devfleet fleet-state --json        # exits 2 with code "invalid_usage" when fleet.json is invalid
```

The `state:definition` check names the file it read. A `fleet.json` without a
`manager` object is not taken for a fleet configuration at all, and the
command then reports that it found none.

### Secrets

dev-fleet asks for four secrets by purpose: `proxy-client-key`,
`monitoring-account-password`, `monitoring-tunnel-token` and
`proxy-tunnel-token`. `secrets.provider` says where they are:

| Provider | `fleet.json`                                                                                                                                         | Where the values are                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `vault`  | `{ "provider": "vault", "address": "https://vault.example.com", "mount": "secret", "locations": { NAME: { "path", "field" } } }` with all four names | A Vault KV v2 mount. Each worker gets its own renewable token.          |
| `sops`   | `{ "provider": "sops", "file": "secrets.enc.yaml" }`                                                                                                 | One encrypted document with one top-level key per name.                 |
| `file`   | `{ "provider": "file" }` (optional `"directory"`)                                                                                                    | One private file per name, default `~/.config/dev-fleet/secrets/NAME`.  |
| `env`    | `{ "provider": "env" }`                                                                                                                              | `DEVFLEET_SECRET_PROXY_CLIENT_KEY` and so on (upper case, `_` for `-`). |

A fifth, `github-token`, is the GitHub token of `worker.githubLogin`: every node
is signed in with it ([GitHub](github.md)). With `vault` it needs no location
of its own: it defaults to the field `GITHUB_TOKEN` beside `proxy-client-key`.

Only `vault` gives each worker its own login and renewal and gives the CLI
proxy its encrypted backup; with the other three those two features are not
available yet. You never write a secret value into the project; the human puts
them in the provider. **Ask** for that step.

### Bucket credentials

Every command reads them from the environment, never from arguments:

```sh
export DEVFLEET_BUCKET_ACCESS_KEY_ID=…
export DEVFLEET_BUCKET_SECRET_ACCESS_KEY=…
```

Pass them however the human keeps secrets: a password manager's `run`
command, `vault kv get` into the environment, or a git-ignored `.env` loaded
with `set -a; . ./.env; set +a`. With neither variable set, the standard AWS
environment or profile is used. A `"directory"` state needs none.

Runs the manager starts by itself (a worker handing `fleet-sync` to the
manager) get no environment, so save the credentials on the manager once:

```sh
npx devfleet fleet-state --init        # takes the bucket from fleet.json, asks on the terminal if the variables are unset
```

## 4. Tell future agents how to use it

Put this in the project's `AGENTS.md` (or `CLAUDE.md`):

```md
The fleet is managed with dev-fleet (`npx devfleet`, pinned in package.json).
Read `npx devfleet commands --json` before using it. Never edit dev-fleet
itself: not node_modules, not a clone, not what it installs on a machine. A
bug in dev-fleet or a feature it lacks is a GitHub issue at
https://github.com/crvouga/dev-fleet/issues; tell me what is blocked and link
it. Issues are public: no credentials, hostnames, accounts, domains or
fleet.json contents.
```

Optionally add scripts, so nobody types the package name:

```json
"scripts": {
  "fleet": "devfleet",
  "fleet:sync": "devfleet fleet-sync",
  "fleet:status": "devfleet fleet-status --workers"
}
```

Commit `package.json`, the lockfile, `fleet.json`, `.gitignore` and
`AGENTS.md`.

## 5. Preview

Run on the manager, from the project, with the bucket credentials in the
environment:

```sh
npx devfleet fleet-state --json
npx devfleet fleet-sync --dry-run --json
```

`fleet-state` reports the `state:bucket` and `state:replica` checks. On a new
fleet the bucket is empty, which is a warning, not a failure: the first sync
seeds it.

Before the first sync, the dry run is expected to stop with
`FLEET_MANAGER_ENROLLMENT_REQUIRED`: no worker's SSH connection and tailnet
identity has been enrolled yet. Anything else is a problem to fix first (see
[failures](#when-something-fails)).

## 6. The first sync is the human's

The first `fleet-sync` must run in a terminal the human is at. It:

- enrolls each declared worker it reaches over host-key-verified SSH, binding
  it to its tailnet device;
- asks once for each worker's sudo password and installs a sudo rule for the
  fleet account (the password is never stored);
- with `vault`, asks for the Vault password once and issues each worker its own
  token.

An agent cannot answer those prompts, and `--json`, `--non-interactive` or a
`CI` variable turn them off. **Ask** the human to run:

```sh
npx devfleet fleet-sync
```

A worker that needs none of those prompts is enrolled without the human: a
run with `--json` or `--non-interactive` enrolls a declared worker when its
pinned host key matched, `sudo -n` works on it, and exactly one tailnet device
matches it (or none, when `fleet.json` declares `tailnet` and its secret
`tailnet-admin`, so the run joins it with a single-use key). The report lists
what it enrolled (`enrolled` in the JSON). A machine made with
`devfleet fleet-node-seed` meets all of these.

It converges the manager first, then the canary worker, then the rest. It
prints one table and the path of the full JSON report
(`~/.local/share/personal/fleet/manager/last-sync.json`, readable by the human
only). The first run on a bare worker takes several minutes: it installs the
operating system packages, mise, the pinned toolchain, T3 and the monitoring
agent.

Then the human signs in, once, to what only they can sign in to:

```sh
npx devfleet cliproxy install           # the CLI proxy on the manager, if the sync reported it missing
npx devfleet cliproxy add-account claude
npx devfleet cliproxy add-account codex
```

and pairs the T3 desktop app on the manager with each worker as its check
remedy says (`t3:paired-access`).

## 7. Verify

These are read-only and safe for an agent to run at any time:

```sh
npx devfleet fleet-status --workers --json    # every worker against the declared policy
npx devfleet fleet-status --json              # the manager and every enrolled worker
npx devfleet fleet-state --json               # the bucket holds what this machine has
npx devfleet fleet-sync --dry-run --json      # what the next sync would do
```

Exit code `0` is success, `1` a failed check, `2` invalid usage or
configuration. Each check is `{ id, status, summary, remedy? }` with status
`pass`, `warn`, `fail` or `skip`. Some checks stay failing until a person
acts (a sign-in, a pairing, a maintenance reboot); they say so in
`remedy.action` and do not stop other workers from converging.

Later syncs need no prompt and may be run by an agent when the human asks:
`npx devfleet fleet-sync --json`.

## When something fails

Read `summary` and `remedy.action` of the failing check. The common ones:

| Code or check                             | Meaning and remedy                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_MANAGER_ENROLLMENT_REQUIRED`       | No worker is enrolled yet. The human runs the first `fleet-sync` in a terminal.                                               |
| `FLEET_NOT_MANAGER`                       | You are not on the machine `manager` names. Run there, or from a worker that can SSH to it.                                   |
| `FLEET_REVISION_REQUIRED`                 | No revision to converge to. Run the installed package (`npx devfleet`), not a copy of its source.                             |
| `FLEET_SOURCE_UNAVAILABLE`                | The revision could not be fetched from `source.repository`. Check the network and that the URL is right.                      |
| `FLEET_STATE_DIVERGED`                    | This machine and the bucket hold different fleet states. `fleet-state --json` explains; never pick one without the human.     |
| `FLEET_MANAGER_LOCKED`                    | Another run holds the manager's lock. Wait for it; do not delete the lock while a run is alive.                               |
| `FLEET_PLAN_STALE`                        | The plan changed after it was approved. Preview again.                                                                        |
| `ssh:host-key`                            | Host key unknown or changed. The human verifies the fingerprint out of band; never disable checking.                          |
| `ssh:auth`, `ssh:dns`, `ssh:network`      | The alias does not work non-interactively. Fix `~/.ssh/config`, the key or Tailscale, then `ssh -o BatchMode=yes ALIAS true`. |
| `TAILSCALE_NODE_OFFLINE`                  | The worker is off or off the tailnet. It is listed and skipped; others continue.                                              |
| `TAILSCALE_DEVICE_REPLACED`               | The tailnet device behind a worker changed. Nothing is written to it until the human confirms the replacement.                |
| `SUDO_AUTHORIZATION_REQUIRED`             | The worker account cannot use sudo without a password. Run the first sync interactively.                                      |
| `UBUNTU_BASELINE_MISMATCH`                | The worker is not an Ubuntu release the [support matrix](support-matrix.md) lists.                                            |
| `WORKER_ENVIRONMENT_UNSUPPORTED`          | The worker is WSL2 or a container. Use a physical or virtual machine of its own.                                              |
| `PACKAGE_NEWER_THAN_PIN` (warning)        | Ubuntu's security updates moved a pinned package past its pin. It is kept; the pin is a minimum.                              |
| `ROOT_DEVELOPMENT_USER_REJECTED`          | The worker's SSH user is root. Use a normal account with sudo.                                                                |
| `BOOTSTRAP_DISK_CAPACITY_REQUIRED`        | Less than 2 GiB free (or too few inodes) where the fleet keeps its files on the worker.                                       |
| `FLEET_REMOTE_LOCKED`                     | Another operation is running on that worker. Wait and run again.                                                              |
| `FLEET_PROMOTION_BLOCKED`                 | The canary (the report names it under `canary`) failed, so the new revision went no further. Fix the canary first.            |
| `VAULT_LOGIN_REQUIRED`                    | The manager is not logged in to Vault. The human logs in; the next sync issues worker tokens.                                 |
| `PROVIDER_UNATTENDED_CREDENTIAL_REQUIRED` | A coding agent has no credential a background service can use. The human signs in on the proxy.                               |
| `BESZEL_ACCOUNT_REQUIRED`                 | The monitoring hub has no account yet. Follow the remedy; other workers are not blocked.                                      |

A failure the remedy does not explain, or one you believe is a defect, is an
issue at <https://github.com/crvouga/dev-fleet/issues>: include
`npx devfleet --version`, the command and flags, and the failing check IDs
and codes; leave out everything private.

## Day to day

- **Add a worker.** Set up its SSH alias and host key and join it to the
  tailnet (step 1), add it under `workers`, commit, then the human runs
  `npx devfleet fleet-sync` once in a terminal to enroll it.
- **Remove a worker.** Delete its entry, commit, run `npx devfleet fleet-sync`.
- **Upgrade the fleet.** `npm install --save-dev --save-exact @crvouga/dev-fleet@latest`,
  commit, `npx devfleet fleet-sync`. The canary proves the new revision first.
  `npx devfleet fleet-sync --rollback` goes back to the revision applied
  before (the revision, tools and T3; system packages roll forward only, as
  the [README](../README.md#the-version) says).
- **Replace the manager.** Follow
  [replacing the manager](manager-recovery.md).

## Moving from a pinned commit and a wrapper script

Some fleets were set up before the package existed: a `fleet.revision` file
holding a commit, and a script that cloned dev-fleet and ran it from that
clone. To move such a project to the package:

1. `npm install --save-dev --save-exact @crvouga/dev-fleet@VERSION`, choosing
   the release whose commit (`npx devfleet --version`) is the one in
   `fleet.revision` or newer.
2. Add the `state` block to `fleet.json` if it has none, with the bucket the
   manager already uses (`~/.config/dev-fleet/bucket.json` on the manager
   names it).
3. Replace every call of the wrapper with `npx devfleet …`, then delete the
   wrapper script and `fleet.revision`.
4. Run `npx devfleet fleet-sync --dry-run --json`, then `npx devfleet fleet-sync`.
5. The CLI proxy on the manager may still run from the old clone: run
   `npx devfleet cliproxy install` once before deleting that clone
   ([state](state.md) explains why).

## Further reading

- [README](../README.md): what dev-fleet assumes and its known limits.
- [Fleet state](state.md): the bucket, replication and recovery.
- [What is declared](declared.md): what is pinned on a machine and what is not.
- [Topology](topology.md): the manager and worker roles.
- [CLI proxy](../cliproxy/README.md) and [monitoring](../ansible/monitoring/README.md).
