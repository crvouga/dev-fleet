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

On the manager (macOS, with Git, Docker Desktop and Tailscale signed in):

```sh
git clone https://github.com/crvouga/dev-fleet.git ~/.local/share/dev-fleet/source
cd ~/.local/share/dev-fleet/source
bash bootstrap/bootstrap.sh          # installs the pinned toolchain with mise

mkdir -p ~/.config/dev-fleet
cp examples/fleet.json ~/.config/dev-fleet/fleet.json
$EDITOR ~/.config/dev-fleet/fleet.json   # your machines, endpoints and secrets

export DEVFLEET_REPO=$PWD
sh bootstrap/fleet-manager-run.sh "$(git rev-parse HEAD)" --dry-run   # preview
sh bootstrap/fleet-manager-run.sh "$(git rev-parse HEAD)"             # apply
```

`fleet-sync` converges the manager first, then every worker over SSH: it sends
the pinned revision and your configuration, installs the toolchain, applies
the Ansible policy and verifies the result. It prints one table and writes a
full JSON report.

Most people keep `fleet.json` in their own repository and point at it:

```sh
DEVFLEET_CONFIG=/path/to/your/fleet.json sh bootstrap/fleet-manager-run.sh REVISION
```

Pin `REVISION` to a full commit SHA of this repository; that is your version.

## Add or remove a machine

1. Set up SSH from the manager to the new Ubuntu box (a non-root user with
   sudo) and join it to your tailnet.
2. Add it under `workers` in `fleet.json`:

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

`fleet.json` is validated by [`schema/fleet.schema.json`](schema/fleet.schema.json);
[`examples/fleet.json`](examples/fleet.json) is a complete example.

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
- State on machines still uses the historical `personal` prefix
  (`~/.local/share/personal/fleet`, `/etc/personal-fleet`, unit names). It
  works, and renaming it needs a migration.
- The manager is a Mac host. There is no container image of the manager.
- The reference documents under `docs/` were written for the fleet this came
  from and are being revised.

## Repository layout

| Path         | What                                                              |
| ------------ | ----------------------------------------------------------------- |
| `src/`       | Inventory, orchestration, verification, the report; `src/cli` CLI |
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

## License

MIT. See [LICENSE](LICENSE).
