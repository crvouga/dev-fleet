# dev-fleet

Keeps a set of development machines in sync: one **manager** and many
**workers**. One command, `fleet-sync`, brings every machine to the same
pinned tools, the same coding agents signed in through one proxy, the same
uptime policy and the same monitoring. Adding or removing a machine is one
entry in `fleet.json`.

Status: extracted from a working three-machine fleet and in daily use there.
It has not yet been set up from nothing by a second person; expect rough edges
and read [what is assumed](#what-it-assumes) first.

## How you use it

You do not clone this repository. dev-fleet is a command you install, and your
fleet is a small project of your own:

```
my-fleet/               your repository
  fleet.json            your machines, your services, the bucket that holds the state
  package.json          pins the dev-fleet version every machine runs
```

You run `devfleet` from inside that project and pass it the credentials of a
storage bucket you own. Nothing else has to be kept:

| What                                                                                    | Where it lives                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The fleet configuration                                                                 | `fleet.json`, in your repository                                   |
| The version of dev-fleet                                                                | The `@crvouga/dev-fleet` dependency in your `package.json`         |
| The fleet state: the enrolled workers, the approved revision, the configuration applied | Your bucket (any S3-compatible service)                            |
| Secrets                                                                                 | The provider `fleet.json` names (`vault`, `sops`, `file` or `env`) |
| The source, checkouts, tools and reports dev-fleet puts on a machine                    | A cache: delete it and `fleet-sync` rebuilds it                    |

The CLI proxy and the monitoring hub on the manager still keep data of their
own; [known limits](#known-limits) says what is lost with the manager.

## What it assumes

dev-fleet is opinionated. These are part of it, not options:

- The **manager** is a macOS machine. You run `fleet-sync` on it, and it hosts
  the shared services (the CLI proxy and the monitoring hub) in Docker Desktop.
- **Workers** are Ubuntu 26.04 machines reached over SSH. They are stateless:
  everything on them is rebuilt from Git and your secrets.
- The fleet state is kept in an **S3-compatible bucket** you own.
- Machines reach each other over **Tailscale**.
- Coding agents (Claude Code, Codex, Grok, OpenCode, Antigravity) run through
  **CLIProxyAPI** on the manager, and **T3 Code** lists one provider per
  account signed in on the proxy.
- Machine policy is **Ansible** (`ansible/`), tool versions are **mise** pins
  (`mise.toml`, `mise.lock`), monitoring is **Beszel**.

What dev-fleet puts on a machine is written in tracked files and pinned to a
version or digest. [What is declared, and where](docs/declared.md) lists it,
and what is not pinned yet.

What it does not assume is anything about you: no account, hostname, domain,
tailnet or repository is written in this code. They live in your `fleet.json`.

## Quickstart

Setting it up with a coding agent? Point it at
[`llms.txt`](llms.txt) or straight at
[Set up a fleet from your own project](docs/consumer-setup.md): the whole
procedure in one pass, including what the agent must ask you for and the
first sync only you can run. Both ship in the package, under
`node_modules/@crvouga/dev-fleet/`.

On the manager you need macOS with Git, Node 22 or newer, Docker Desktop and
Tailscale signed in. You also need an empty private bucket on any
S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2, MinIO) and an
access key that can read and write it.

```sh
mkdir my-fleet && cd my-fleet && git init
npm init -y
npm install --save-dev --save-exact @crvouga/dev-fleet

npx devfleet fleet-state --example > fleet.json
$EDITOR fleet.json                   # your machines, and your bucket under "state"

export DEVFLEET_BUCKET_ACCESS_KEY_ID=…
export DEVFLEET_BUCKET_SECRET_ACCESS_KEY=…
npx devfleet fleet-sync --dry-run    # preview
npx devfleet fleet-sync              # apply
```

Commit `fleet.json`, `package.json` and the lockfile. Keep the two credentials
out of Git: pass them from wherever you keep secrets (a password manager's
`run` command, a git-ignored `.env`, your shell). They are read from the
environment and never taken from arguments.

`fleet-sync` converges the manager first, then every worker over SSH. It
fetches the commit your dev-fleet version was published from, sends it and
your configuration to each machine, installs the pinned toolchain, applies the
Ansible policy and verifies the result. It prints one table and writes a full
JSON report. The first run on a machine installs everything, mise included, so
Git is the only tool it needs beforehand.

`--dry-run` changes no machine. It first brings the manager's copy of the
fleet state up to the bucket (never uploading), then prints, and adds to
`--json` as `plan`, what a sync would change: the revision, each tool pin that
moves, and what restarts because of it (a T3 restart ends its running agent
turns). On the manager it checks the release out into
dev-fleet's cache and installs the Bun that release pins beside any others, so
that it can run; it never installs the toolchain, publishes the global mise
configuration, edits shell profiles or touches a worker.

`devfleet` finds the closest `fleet.json` in the directory you run it from or
above it. `DEVFLEET_CONFIG` names a file elsewhere.

The CLI runs on [Bun](https://bun.sh), which the package brings as a
dependency. If your package manager does not run dependency install scripts,
allow Bun's or install Bun yourself; the CLI uses the one on `PATH`.

## The version

Every release of `@crvouga/dev-fleet` is published from one commit and names
it. The version in your `package.json` is therefore the revision of every
machine in the fleet:

```sh
npx devfleet --version               # 1.4.0 (commit 3f2a…)
npm install --save-dev --save-exact @crvouga/dev-fleet@latest
npx devfleet fleet-sync              # the fleet moves to that release
```

Install an older version and run `fleet-sync` to go back. The first worker
proves a new revision before the others receive it.

## Your project's own tools

On a fleet machine the global mise configuration (`~/.config/mise/config.toml`
and its `mise.lock`) belongs to dev-fleet: `fleet-sync` publishes it with the
fleet's pinned tools and the agent worktree roots mise must trust. A project
pins its own tools in its own `mise.toml` and installs them with
`mise install --locked` in its checkout. It never publishes a global
configuration. If anything replaces dev-fleet's, `fleet-status` fails the check
`tool:global-mise-config` until the next `fleet-sync`.

## Using it from code

dev-fleet has no library API. The package is the `devfleet` command: it
declares no `main` or `exports`, and nothing under `src/`, `bootstrap/` or
`ansible/` is a supported import. Any release, a patch included, may change
them, and some modules read the fleet configuration as soon as they are
imported. If your project needs something dev-fleet does, ask for a command in
an [issue](#bugs-and-feature-requests).

## State

Your bucket is the source of truth for everything Git does not hold: the
roster of enrolled workers, the approved revision, and the configuration
`fleet-sync` last applied. It is one SQLite database that
[Litestream](https://litestream.io) replicates to the bucket. `fleet.json`
says where the bucket is and the command is passed its credentials:

```json
"state": {
  "bucket": "my-fleet-state",
  "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com",
  "region": "auto"
}
```

```sh
npx devfleet fleet-state             # where the state is, and how it stands with the bucket
```

The copy on the manager is disposable. **To replace the manager**, clone your
project on the new machine and run the same two commands:

```sh
npm ci
npx devfleet fleet-sync              # with the two bucket credentials in the environment
```

The roster and the approved revision come back from the bucket, and the
machine is rebuilt from Git.

Some runs are started by a machine rather than by you: a worker that hands
`fleet-sync` to the manager, for example. They get no environment, so save the
credentials on the manager once (in `~/.config/dev-fleet/bucket.json`,
readable by you alone):

```sh
npx devfleet fleet-state --init
```

Without a bucket everything still works from the local copy, and `fleet-sync`
warns that the manager holds the only one. [docs/state.md](docs/state.md)
explains how replication stays correct, how to move an existing fleet to a
project, and which state is not in the bucket yet.

## Provider accounts

Provider accounts live only on the CLI proxy. `npx devfleet fleet-accounts`
lists them with their state; `--add`, `--relogin` and `--remove` change one
and propagate the result to every node, and `fleet-sync --only accounts`
propagates them without a full sync.
[docs/accounts.md](docs/accounts.md) explains how.

## Add or remove a machine

1. Set up SSH from the manager to the new Ubuntu box (a non-root user with
   sudo) and join it to your tailnet.
2. Add it under `workers` in your `fleet.json` and commit:

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

3. Run `fleet-sync`. A machine that has only an SSH server and an account
   with sudo is enough: every pull request proves that against a bare
   Ubuntu machine, over SSH
   ([`fresh-box.feature`](features/fresh-box/fresh-box.feature)).

Remove a machine by deleting its entry and running `fleet-sync`.

## Configuration

Your `fleet.json` is validated by
[`schema/fleet.schema.json`](schema/fleet.schema.json), which the installed
package carries: `fleet-state --example` prints a complete example that points
`$schema` at it, so an editor checks the file as you type.
[`examples/fleet.json`](examples/fleet.json) is the same example.

| Block      | What it declares                                                    |
| ---------- | ------------------------------------------------------------------- |
| `source`   | The Git repository nodes accept code from (this one, or your fork)  |
| `state`    | The bucket that holds the fleet state; never its credentials        |
| `secrets`  | Where secrets are kept: `env`, `file`, `sops` or `vault`            |
| `manager`  | The one macOS manager                                               |
| `workers`  | The Ubuntu workers                                                  |
| `services` | The proxy's public origin and the monitoring dashboard and accounts |
| `worker`   | Policy every worker must meet                                       |
| `ides`     | The IDEs every machine runs; `["t3"]` when absent                   |
| `t3`       | T3 settings every machine holds (`profile`) and `requiredModels`    |

### Supported IDEs

Every supported IDE is reached through one interface (`src/ide/ide.ts`): its
settings on each machine, the manager's own copy (pinned version and policy)
and what the manager measures of each worker. Enabling one is `ides` in
`fleet.json`.

| IDE     | `ides` | Manager                                               | Workers                                    |
| ------- | ------ | ----------------------------------------------------- | ------------------------------------------ |
| T3 Code | `t3`   | Pinned CLI, policy with updates off, version measured | Pinned desktop app, locked policy, pairing |

Under `t3.profile`, `fleet.json` names top-level T3 settings every machine
holds the same, such as tool servers. A setting not named there stays the
machine's own, and one edited on a machine since `fleet-sync` last wrote it
is reported as `T3_PROFILE_CONFLICT` by the check `t3:profile`, never
overwritten. The check `t3:models` reports a model T3 offers that the proxy
does not serve, and a model in `t3.requiredModels` that is missing.

Secrets are asked for by purpose (`proxy-client-key`,
`monitoring-account-password`, `monitoring-tunnel-token`,
`proxy-tunnel-token`); see [`src/secrets.ts`](src/secrets.ts).

`fleet-sync` records the configuration it applies in the fleet state, so a
run started outside your project uses the one last applied.
`fleet-state --export` prints it.

To run your own fork, publish it as your own package and name its repository
under `source`: the commit a package names must be reachable there.

## Bugs and feature requests

A defect in dev-fleet, or something it cannot do yet, is raised as an
[issue](https://github.com/crvouga/dev-fleet/issues). From your project that
is the only way to change dev-fleet, for you and for the coding agents working
there. Do not patch the installed package, a checkout `fleet-sync` put on a
machine or a file it manages: the next install or `fleet-sync` replaces them.

The tool says so itself: `devfleet --help` names the issue tracker, and the
agent contract (`devfleet commands --json`, under `agent.support`) carries the
rule, what an issue should include and what it must leave out. Agents only
read it if your project sends them there, so put this in the `AGENTS.md` of
the project that holds your `fleet.json`:

```md
The fleet is managed with dev-fleet (`npx devfleet`, pinned in package.json).
Read `npx devfleet commands --json` before using it. Never edit dev-fleet
itself: not node_modules, not a clone, not what it installs on a machine. A
bug in dev-fleet or a feature it lacks is a GitHub issue at
https://github.com/crvouga/dev-fleet/issues; tell me what is blocked and link
it. Issues are public: no credentials, hostnames, accounts, domains or
fleet.json contents.
```

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
- The CLI proxy's installed code is a Git worktree of the manager's copy of
  the source repository (`~/.local/share/personal/fleet/manager/source`).
  `fleet-sync` fetches that copy again when it is deleted, but the proxy then
  needs `devfleet cliproxy install` once more.
- The manager is a Mac host. There is no container image of the manager.
- `fleet-sync --schedule enable --apply --yes` (unattended runs every 30
  minutes) is installed by that command on the manager, not yet by the
  manager's playbook, and its interval is not yet part of `fleet.json`.
  `fleet-sync --schedule status` lists its last runs, and `fleet-status` fails
  `manager:schedule` when it has not converged the fleet for two intervals.
- Not everything on a machine is pinned. [What is declared, and
  where](docs/declared.md) lists what is and what is not: most of a worker's
  own packages, the manager's applications and every login are outside it.
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
| `features/`  | What dev-fleet does, as Gherkin features: the tests               |
| `bin/`       | The entry point of the published package                          |

## Develop

Working on dev-fleet itself is the only reason to clone it:

```sh
git clone https://github.com/crvouga/dev-fleet.git && cd dev-fleet
bash bootstrap/bootstrap.sh
bun install --frozen-lockfile
bun run check
./devfleet fleet-status --local      # the CLI, from this checkout
```

Run from a checkout, `fleet-sync` converges the fleet to the checkout's `HEAD`
commit (never to uncommitted files). The checkout's `origin` must be the
repository `fleet.json` names under `source`. Every merge to `main` publishes a release;
see [releasing](docs/releasing.md).

What dev-fleet does is specified in Gherkin, under
[`features/`](features/README.md): a `.feature` file states a rule in plain
words and the steps beside it check it. There are no other TypeScript tests.
`bun run check` runs formatting, typecheck, lint, every feature and the proxy
package's Python tests. Features run against `examples/fleet.json` and never
contact a real machine.

Every pull request runs these checks ([`ci.yml`](.github/workflows/ci.yml)):

| Check                 | What it proves                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Check                 | `bun run check`                                                                                                                   |
| Fleet state           | The pinned Litestream replicates the fleet state to a directory and to an S3 API, and a second manager restores it                |
| Fresh worker over SSH | A new Ubuntu machine with only an SSH server and sudo is bootstrapped by the production code over real SSH, on amd64 and on arm64 |
| Workflows             | The workflow files pass `actionlint`                                                                                              |

Some scenarios need something a laptop may not have, and are skipped there:

```sh
DEVFLEET_TEST_FRESH_BOX=1 bun test features/fresh-box     # Docker; tests the HEAD commit
mise install litestream
DEVFLEET_TEST_S3=http://127.0.0.1:5000 bun test features/state
```

## License

MIT. See [LICENSE](LICENSE).
