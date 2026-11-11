# dev-fleet

Keeps a set of development machines in sync: one **manager** and many
**workers**. One command, `fleet-sync`, brings every machine to the same
pinned tools, the same coding agents signed in through one proxy, the same
uptime policy and the same monitoring. Adding or removing a machine is one
entry in `fleet.json`.

Status: extracted from a working three-machine fleet and in daily use there.
It has not yet been set up from nothing by a second person; expect rough edges
and read [what is assumed](#what-it-assumes) first.

## What it assumes

dev-fleet is opinionated. These are part of it, not options:

- The **manager** is a macOS machine. It runs `fleet-sync` and hosts the
  shared services (the CLI proxy and the monitoring hub) in Docker Desktop.
- **Workers** are Ubuntu 26.04 machines reached over SSH. They are stateless:
  everything on them is rebuilt from Git and your secrets.
- Machines reach each other over **Tailscale**.
- Coding agents (Claude Code, Codex, Grok, OpenCode, Antigravity) run through
  **CLIProxyAPI** on the manager, and **T3 Code** lists one provider per
  account signed in on the proxy.
- Machine policy is **Ansible** (`ansible/`), tool versions are **mise** pins
  (`mise.toml`, `mise.lock`), monitoring is **Beszel**.

What it does not assume is anything about you: no account, hostname, domain,
tailnet or repository is written in this code. They live in your `fleet.json`.

## Quickstart

On the manager (macOS, with Git, Docker Desktop and Tailscale signed in), clone
this repository and run everything from the clone:

```sh
git clone https://github.com/crvouga/dev-fleet.git
cd dev-fleet
bash bootstrap/bootstrap.sh          # installs the pinned toolchain with mise

# Connect the bucket that holds your fleet's state (asks for its access key).
./devfleet fleet-state --init --bucket my-fleet-state \
  --endpoint https://ACCOUNT.r2.cloudflarestorage.com --region auto

# A new fleet: describe your machines once. An existing fleet skips this;
# --init already restored its configuration from the bucket.
cp examples/fleet.json /tmp/fleet.json && $EDITOR /tmp/fleet.json
./devfleet fleet-state --import /tmp/fleet.json && rm /tmp/fleet.json

./devfleet fleet-sync --dry-run      # preview
./devfleet fleet-sync                # apply
```

`fleet-sync` converges the manager first, then every worker over SSH: it sends
the revision the clone is at and your configuration, installs the toolchain,
applies the Ansible policy and verifies the result. It prints one table and
writes a full JSON report. The commit the clone is at is your version; check
out another one to move the fleet to it.

## State

The fleet's own state is not kept only on the manager. The fleet
configuration, the roster of enrolled workers and the approved revision live in
one SQLite database, which [Litestream](https://litestream.io) replicates to a
storage bucket you own (any S3-compatible service). The bucket is the source of
truth and the local copy is disposable:

```sh
./devfleet fleet-state               # where the state is, and how it stands with the bucket
```

To replace the manager, clone this repository on the new machine and run the
same `fleet-state --init`: the fleet comes back from the bucket. The bucket's
location and credentials (`~/.config/dev-fleet/bucket.json`) are the only thing
you bring. [docs/state.md](docs/state.md) explains how it works, how to change
the configuration, and which state is not in the bucket yet.

Without a bucket everything still works from the local copy, and `fleet-sync`
warns that the manager holds the only one.

## Run it from npm

The CLI is also published as `@crvouga/dev-fleet`, for any machine or project
that has Node:

```sh
npx @crvouga/dev-fleet commands --json
npx @crvouga/dev-fleet fleet-status --local
```

`fleet-sync` still runs from a clone, because it pins a git revision. See
[releasing](docs/releasing.md) for how versions are published.

## Add or remove a machine

1. Set up SSH from the manager to the new Ubuntu box (a non-root user with
   sudo) and join it to your tailnet.
2. Add it under `workers` in the fleet configuration
   (`fleet-state --export`, edit, `fleet-state --import`):

   ```json
   {
     "id": "worker-three",
     "ssh": "worker-three",
     "os": "linux",
     "network": {
       "tailscaleName": "worker-three.tail0a1b2c.ts.net",
       "sshPort": 22,
       "user": "dev",
       "t3Port": 3773
     }
   }
   ```

3. Run `fleet-sync`. A box that has only sudo is enough: the opt-in test
   `bun ansible/ubuntu/tests/fresh-box.ts` proves that against a bare
   container.

Remove a machine by deleting its entry.

## Configuration

The fleet configuration (`fleet.json`) is validated by
[`schema/fleet.schema.json`](schema/fleet.schema.json);
[`examples/fleet.json`](examples/fleet.json) is a complete example. It is kept
in the [fleet state](#state): `fleet-state --export` prints it and
`fleet-state --import PATH` stores an edited copy. To keep it in a repository
of your own instead, name the file with `DEVFLEET_CONFIG`.

| Block      | What it declares                                                    |
| ---------- | ------------------------------------------------------------------- |
| `source`   | The Git repository nodes accept code from (this one, or your fork)  |
| `secrets`  | Where secrets are kept: `env`, `file`, `sops` or `vault`            |
| `manager`  | The one macOS manager                                               |
| `workers`  | The Ubuntu workers                                                  |
| `services` | The proxy's public origin and the monitoring dashboard and accounts |
| `worker`   | Policy every worker must meet                                       |

Secrets are asked for by purpose (`proxy-client-key`,
`monitoring-account-password`, `monitoring-tunnel-token`,
`proxy-tunnel-token`); see [`src/secrets.ts`](src/secrets.ts).

## Known limits

- Each worker's own login and renewal, and the proxy's backup and recovery,
  are implemented for the **`vault`** secrets provider only. With `env`, `file`
  or `sops` the fleet's three shared secrets are read, but those two features
  are not available yet.
- The bucket holds the fleet's own state. The CLI proxy keeps its separate
  encrypted backup (`vault` only), and the monitoring hub's database is not
  replicated: `fleet-sync` recreates its accounts and systems, but metric
  history is lost with the manager. See
  [what is not in the bucket yet](docs/state.md#what-is-not-in-the-bucket-yet).
- Caches and units on machines still use the historical `personal` prefix
  (`~/.local/share/personal/fleet`, `/etc/personal-fleet`, unit names). It
  works, and renaming it needs a migration.
- The manager is a Mac host. There is no container image of the manager.
- The reference documents under `docs/` were written for the fleet this came
  from and are being revised.

## Repository layout

| Path         | What                                                              |
| ------------ | ----------------------------------------------------------------- |
| `src/`       | Inventory, orchestration, verification, the report; `src/cli` CLI |
| `src/state/` | The fleet state database and its replication to the bucket        |
| `ansible/`   | Machine policy: `ubuntu/`, `macos/`, `monitoring/`                |
| `agents/`    | Agent launchers T3 runs, and their registry                       |
| `cliproxy/`  | The CLIProxyAPI service: install, audit, backup, model health     |
| `bootstrap/` | Toolchain bootstrap and the manager and worker entry scripts      |
| `schema/`    | JSON schemas for `fleet.json` and the private roster              |
| `examples/`  | A complete example configuration                                  |

## Develop

```sh
bash bootstrap/bootstrap.sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs formatting, typecheck, lint, the TypeScript tests and the
proxy package's Python tests. Tests run against `examples/fleet.json` and
never contact a real machine.

Every pull request runs three checks ([`ci.yml`](.github/workflows/ci.yml)):

| Check       | What it proves                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Check       | `bun run check`                                                                                                    |
| Fleet state | The pinned Litestream replicates the fleet state to a directory and to an S3 API, and a second manager restores it |
| Workflows   | The workflow files pass `actionlint`                                                                               |

The fleet state tests that need Litestream skip where it is not installed. To
run them all locally, start any S3-compatible service and name it:

```sh
mise install litestream
DEVFLEET_TEST_S3=http://127.0.0.1:5000 bun test tests/state/litestream.test.ts
```

## License

MIT. See [LICENSE](LICENSE).
