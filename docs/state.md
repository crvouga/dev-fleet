# Fleet state

A fleet is described in two places you own. Your project in Git holds
`fleet.json` and pins the dev-fleet version. Everything else the manager
cannot rebuild from Git is the **fleet state**:

| Document     | What it is                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roster`     | The enrolled connection to each worker (SSH alias, Tailscale device)                                                                                                          |
| `enrollment` | The revision `fleet-sync` approved and the one it last applied                                                                                                                |
| `definition` | The fleet configuration `fleet-sync` last applied: your `fleet.json`                                                                                                          |
| `history`    | The last 90 days of `fleet-sync` runs (at most 500), and the schedule                                                                                                         |
| `workers`    | Per worker: its pinned SSH host key, whether it is parked and since when, whether it came from a worker record, and whether the manager is to pair its T3 after a replacement |

`devfleet fleet-watch` also keeps `watch.json` in the bucket, beside the
database: the health of each worker when it last looked, and when that was
(the manager's heartbeat). Losing it costs at most one repeated notification.

The three documents live in one SQLite database, and [Litestream](https://litestream.io)
replicates that database to a storage bucket you own. The bucket is the source
of truth. The copy on the manager is disposable: delete it, or replace the
whole machine, and the next command brings the fleet back.

```
your project (Git)
    fleet.json                          the configuration; says where the bucket is
    package.json                        the dev-fleet version
~/.local/share/dev-fleet/state/         the local copy of the state; safe to delete
    fleet.db                            the database Litestream replicates
    definition.json                     the stored configuration as a file, rewritten from fleet.db
    replicated.json, litestream.yml     bookkeeping
~/.config/dev-fleet/bucket.json         optional: credentials saved for unattended runs
```

## Set it up

Any S3-compatible bucket works: AWS S3, Cloudflare R2, Backblaze B2, MinIO.
Create an empty private bucket and an access key that can read and write it.
Name the bucket in `fleet.json`:

```json
"state": {
  "bucket": "my-fleet-state",
  "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com",
  "region": "auto",
  "prefix": "dev-fleet"
}
```

Omit `endpoint` for AWS S3. `prefix` defaults to `dev-fleet`; one bucket can
hold several fleets under different prefixes. The block never holds
credentials, and a `fleet.json` that does is refused.

Every devfleet command reads the credentials from its environment:

```sh
export DEVFLEET_BUCKET_ACCESS_KEY_ID=…
export DEVFLEET_BUCKET_SECRET_ACCESS_KEY=…
npx devfleet fleet-sync
```

Set both or neither. With neither, and nothing saved on the machine, the
standard AWS environment or profile is used. Credentials are never taken from
arguments and never written to a report or a log.

**A new fleet.** Nothing more: the first `fleet-sync` seeds the bucket.

**A replacement manager.** The bucket already holds the fleet, so its state is
downloaded before anything is changed. Follow
[replacing the manager](manager-recovery.md).

**Runs the manager starts by itself.** A worker that hands `fleet-sync` to the
manager starts a command there that gets no environment and no project. Save
the credentials on the manager once:

```sh
npx devfleet fleet-state --init
```

It takes the bucket from `fleet.json` and the credentials from the environment,
or asks for them on the terminal, and writes both to
`~/.config/dev-fleet/bucket.json` (readable by you alone). Such a run then
uses the configuration last applied and the saved credentials. Without them it
still converges the fleet from the local copy and reports that the bucket was
not reached; the next run that has credentials uploads what is pending.

**A fleet that kept its configuration in the bucket.** Before projects, the
configuration was stored with `fleet-state --import` and the bucket was named
with `fleet-state --init --bucket …`. To move such a fleet into a project, on
the manager:

```sh
mkdir my-fleet && cd my-fleet && git init && npm init -y
npm install --save-dev --save-exact @crvouga/dev-fleet
npx devfleet fleet-state --export > fleet.json
```

Add the `state` block to `fleet.json` with the same bucket, endpoint, region
and prefix as `~/.config/dev-fleet/bucket.json`, then run
`npx devfleet fleet-sync`. The credentials already saved for that bucket keep
working.

The clone of dev-fleet the fleet used to run from is then no longer read by
`fleet-sync`, with one exception: the CLI proxy's installed code is a Git
worktree of the repository it was installed from. Install the proxy again
from the project (`npx devfleet cliproxy install`, which takes the revision
`fleet-sync` applied from the manager's own copy of the source) before you
delete the clone.

Without a `fleet.json`, `fleet-state --init --bucket NAME --endpoint https://HOST`
still connects a bucket and restores the configuration stored in it.

On a manager older than the fleet state itself, `--init` (or the first
`fleet-sync`) also moves the configuration, the roster and the approved
revision from the files that held them into the state. Those files are left in
place and no longer read.

`"state": { "directory": "/Volumes/backup/fleet" }` replicates to a directory
instead of a bucket (an attached disk, a mounted share). It behaves the same
way, needs no credentials and is the quickest way to try this out.

## Day to day

```sh
devfleet fleet-state            # read-only: where the state is, and how it stands with the bucket
devfleet fleet-state --example  # print a fleet.json to start a project from
devfleet fleet-report --since 30d  # read-only: how reliably fleet-sync ran, from the history
devfleet fleet-state --export   # print the configuration fleet-sync last applied
devfleet fleet-state --push     # upload changes made while the bucket was unreachable
devfleet fleet-state --restore  # replace the local copy with the bucket's
```

To change the fleet, for example to add a worker, edit `fleet.json`, commit
and run `devfleet fleet-sync` from the project. `fleet-sync` validates the
file, installs it on every machine and records it in the state.

Which configuration a command uses, in this order:

1. The file `DEVFLEET_CONFIG` names.
2. The closest `fleet.json` in the working directory or above it.
3. The configuration `fleet-sync` last applied, from the fleet state (the
   devfleet CLI on the manager).
4. The copy `fleet-sync` installed at `~/.config/dev-fleet/fleet.json`
   (launchers and scheduled jobs on every machine read only this one).

`fleet-state --import PATH` stores a configuration in the state without
running `fleet-sync`.

## How it stays correct

Litestream does not run as a daemon. A devfleet command that changes the state
runs it once, so the command has not finished until the bucket has the change
and nothing has to be kept running on the manager. Every change follows the
same three steps:

1. **Download** the bucket's current version and compare it with the local copy.
2. **Change** the local copy, on top of the bucket's version.
3. **Upload**, then download again. The change counts only once a restore from
   the bucket returns it.

`fleet-sync` does step 1 before it reads the configuration and step 3 after
it records what it applied. Its report carries the result as the
`state:replica` check.

`fleet-state` reports one of these:

| Standing       | Meaning                                                | What happens                                               |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `in-sync`      | The bucket and this machine hold the same version      | Nothing to do                                              |
| `local-only`   | No bucket is configured                                | A warning on every `fleet-sync`; name one in `fleet.json`  |
| `empty`        | Neither side holds any state                           | The first `fleet-sync` records it                          |
| `unpublished`  | The bucket holds nothing yet                           | The next change, or `--push`, seeds it                     |
| `local-ahead`  | This machine has changes the bucket has not received   | The next change, or `--push`, uploads them                 |
| `bucket-ahead` | Another manager changed the bucket; this copy is stale | The next change or `fleet-sync` takes the bucket's version |
| `unreachable`  | The bucket did not answer, or did not take an upload   | Changes still apply locally and are uploaded later         |
| `corrupt`      | The bucket answered with a version that cannot be read | Changes apply locally; `--restore --timestamp` repairs it  |
| `diverged`     | Both sides changed                                     | Refused. `--restore --yes` takes the bucket's version      |

A stale copy never overwrites the bucket. A machine that was offline while
another one changed the fleet is brought up to date before it can change
anything, and if it also changed something itself it stops and says so. The
bucket wins: export what you still need, then `--restore --yes`.

An unreachable bucket does not block `fleet-sync`. The fleet converges, the
report warns, and the next command uploads what is pending.

## What is not in the bucket yet

The fleet state covers what `fleet-sync` itself needs. The manager also holds
state that is replicated differently or not at all:

| State                                                | Where                                                    | If the manager is lost                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Secrets                                              | Your `secrets` provider (`vault`, `sops`, `file`, `env`) | Unaffected for `vault`; `file` and `env` secrets must be supplied again                                |
| CLI proxy: provider logins, keys, Tailscale identity | `~/Library/Application Support/cliproxy-fleet/state`     | Restored from its own encrypted restic snapshots ([cliproxy](../cliproxy/README.md)); needs `vault`    |
| Monitoring hub (Beszel) database                     | `~/Library/Application Support/personal-beszel`          | `fleet-sync` recreates accounts and systems; metric history, alerts and settings made by hand are lost |
| T3 ownership record                                  | `~/.t3/userdata/personal-managed.json`                   | `t3-apply --import ID` adopts instances again                                                          |

The manager reaches a worker that has no SSH alias against
`~/.local/share/dev-fleet/ssh/known_hosts` (beside the state directory): a
cache rendered from the host keys the `workers` document pins and the worker
records declare, rewritten before every session. Delete it and the next
command writes it again; nothing is ever learned into it.

Everything else under `~/.local/share/personal/fleet` and
`~/.local/state/personal/fleet` (the copy of the source repository, run
checkouts, reports, receipts, logs) is a cache that the next `fleet-sync`
rebuilds. The CLI proxy's installed code is a Git worktree of that copy of the
source repository: after deleting it, run `devfleet cliproxy install` again
once `fleet-sync` has fetched it back.

## Reference

| Setting                                                              | Meaning                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `state` in `fleet.json`                                              | Where the bucket is                                          |
| `DEVFLEET_BUCKET_ACCESS_KEY_ID`, `DEVFLEET_BUCKET_SECRET_ACCESS_KEY` | The bucket's credentials, for the command they are passed to |
| `DEVFLEET_CONFIG`                                                    | A configuration file, instead of the project's `fleet.json`  |
| `DEVFLEET_STATE`                                                     | Another state directory. Earlier files are not read for it   |
| `DEVFLEET_BUCKET`                                                    | Another `bucket.json`                                        |
| `DEVFLEET_MANAGER_HOLDER`                                            | How the manager lease names this machine                     |

How a command reaches the bucket:

- **Where it is**: the `state` block of the configuration; without one, the
  bucket saved in `bucket.json`.
- **Credentials**: the two variables; otherwise the ones saved in
  `bucket.json`, only when they were saved for that same bucket; otherwise the
  standard AWS environment or profile.

`fleet-state --json` reports both as `bucket.location` (`fleet.json` or
`bucket.json`) and `bucket.credentials` (`environment`, `bucket.json` or
`aws`), never a credential.

`bucket.json`, written by `fleet-state --init`:

```json
{
  "version": 1,
  "bucket": "my-fleet-state",
  "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com",
  "region": "auto",
  "prefix": "dev-fleet",
  "accessKeyId": "…",
  "secretAccessKey": "…"
}
```

It must be readable by you alone (`chmod 600`); devfleet refuses to use it
otherwise. The keys reach Litestream through its environment and are never
written to its configuration, a report or a log. To rotate them, pass the new
ones to `fleet-state --init`.

The database is stored under `PREFIX/fleet.db/`. Each change adds a few
kilobytes and Litestream keeps thirty days of snapshots, so a restore to an
earlier point is possible with Litestream directly (with the bucket's keys in
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`):

```sh
mise exec litestream -- litestream restore -no-expand-env \
  -config ~/.local/share/dev-fleet/state/litestream.yml \
  -timestamp 2026-11-01T00:00:00Z -o /tmp/fleet-then.db \
  ~/.local/share/dev-fleet/state/fleet.db
```

`devfleet fleet-state --restore --timestamp 2026-11-01T00:00:00Z --yes` does
the same and then uploads that version as the bucket's current one, which
takes the manager lease. It is the remedy for a `corrupt` replica: the bucket
answers, but its latest version cannot be read. `--yes` consents to replacing
the bucket, not to replacing another manager: while one holds the lease in the
bucket's current version, the restore stops with `FLEET_MANAGER_LEASE_HELD`
before it changes anything, and `--take-over` overrides it. When the current
version cannot be read, its lease cannot either, and the lease in this
machine's copy (the last one it saw) decides instead.

Litestream is pinned in `mise.toml` and installed the first time it is used.
The manager is the only machine that runs it.

## One manager at a time

The fleet state carries a **manager lease**: which machine is the manager,
and until when. Every change takes or renews it, and it reaches the bucket
with the change. A second machine (a replacement while the old manager still
runs, or an old manager that wakes up) reads it from the bucket before it
writes anything and stops with `FLEET_MANAGER_LEASE_HELD`. `fleet-state
--init` still restores the state on such a machine; it only writes nothing.

The lease runs for seven days after the last change. After that, any machine
may take it. Before that, `--take-over` (on `fleet-sync`, `fleet-state --init`,
`fleet-state --import` or `fleet-state --restore --timestamp`) makes this machine the manager; use it only once
the other one is gone ([replacing the manager](manager-recovery.md)).

A machine is named in the lease by a digest of its machine ID
(`/etc/machine-id` on Linux, the hardware UUID on macOS), never by its host
name, which a replacement shares. `DEVFLEET_MANAGER_HOLDER` names it instead.

## Schema version

The database records its schema version in `PRAGMA user_version`. The schema
is a series of numbered migrations (`src/state/migrations/0001-….sql`, …),
and a command brings an older database forward before it writes. A database a
newer dev-fleet wrote is refused with `FLEET_STATE_NEWER_THAN_CLI`, read or
written, and nothing in it changes: install the dev-fleet version the fleet
runs.

## Local command locking

The CLI holds an exclusive SQLite transaction in `sync.guard.sqlite` beside
`sync.lock` while a manager operation runs. This file holds no fleet data;
it is a disposable local lock, never replicated to the bucket. Its stable
inode lets SQLite serialize commands through the operating system even while
an abandoned `sync.lock` directory is removed. Do not unlink the guard file
while any command is running. Process exit releases the kernel lock.

The historical directory and owner marker remain, so a live command from an
older release is still refused. Finish commands from older releases before
upgrading: they do not acquire the new guard. Worker probes and launchers
continue to use Node; only the Bun CLI imports the locking module.
