# Fleet state

The manager keeps three things it cannot rebuild from Git:

| Document     | What it is                                                           |
| ------------ | -------------------------------------------------------------------- |
| `definition` | The fleet configuration: your `fleet.json`                           |
| `roster`     | The enrolled connection to each worker (SSH alias, Tailscale device) |
| `enrollment` | The revision `fleet-sync` approved and the one it last applied       |

They live in one SQLite database, the **fleet state**, and
[Litestream](https://litestream.io) replicates that database to a storage
bucket you own. The bucket is the source of truth. The copy on the manager is
disposable: delete it, or replace the whole machine, and one command brings the
fleet back.

```
~/.config/dev-fleet/bucket.json         where the bucket is, and its credentials
~/.local/share/dev-fleet/state/         the local copy; safe to delete
    fleet.db                            the database Litestream replicates
    definition.json                     the configuration as a file, rewritten from fleet.db
    replicated.json, litestream.yml     bookkeeping
```

`bucket.json` is the one file you bring to a machine. Everything else comes
from the bucket or from Git.

## Set it up

Any S3-compatible bucket works: AWS S3, Cloudflare R2, Backblaze B2, MinIO.
Create an empty private bucket and an access key that can read and write it.

**A new fleet.** From the clone on the manager:

```sh
./devfleet fleet-state --init --bucket my-fleet-state \
  --endpoint https://ACCOUNT.r2.cloudflarestorage.com --region auto
cp examples/fleet.json /tmp/fleet.json && $EDITOR /tmp/fleet.json
./devfleet fleet-state --import /tmp/fleet.json && rm /tmp/fleet.json
```

`--init` asks for the access key ID and its secret on the terminal. Without a
terminal it reads `DEVFLEET_BUCKET_ACCESS_KEY_ID` and
`DEVFLEET_BUCKET_SECRET_ACCESS_KEY`. Credentials are never taken from
arguments. Omit `--endpoint` for AWS S3. Leave the access key empty to use the
standard AWS environment or profile instead of storing keys.

**A manager that already runs a fleet.** Run `--init` with your bucket. It
copies the configuration, the roster and the approved revision from the files
that held them into the state and uploads them. The roster and enrollment files
are left in place and no longer read; `~/.config/dev-fleet/fleet.json` stays
what it was, the copy `fleet-sync` installs for launchers. Without `--init`
the first `fleet-sync` makes the same move, and warns until a bucket is
connected. If the `fleet-sync` schedule was enabled before, enable it again
(`fleet-sync --schedule enable --apply --yes`) so that it stops naming the old
roster file.

**A replacement manager, or a second clone.** Run the same `--init`. The
bucket already holds the fleet, so it is downloaded and nothing on the machine
is uploaded. Then run `fleet-sync`.

`--init --directory /Volumes/backup/fleet` replicates to a directory instead of
a bucket (an attached disk, a mounted share). It behaves the same way and is
the quickest way to try this out.

## Day to day

```sh
devfleet fleet-state            # read-only: where the state is, and how it stands with the bucket
devfleet fleet-state --export   # print the configuration
devfleet fleet-state --import PATH   # store an edited configuration
devfleet fleet-state --push     # upload changes made while the bucket was unreachable
devfleet fleet-state --restore  # replace the local copy with the bucket's
```

To change the fleet, for example to add a worker:

```sh
devfleet fleet-state --export > /tmp/fleet.json
$EDITOR /tmp/fleet.json
devfleet fleet-state --import /tmp/fleet.json && rm /tmp/fleet.json
devfleet fleet-sync
```

`--import` validates the file before it stores anything. `fleet-sync` then
installs the stored configuration on every machine, as it always has.

You can still keep `fleet.json` in a repository of your own and name it with
`DEVFLEET_CONFIG`. A named file wins, and then only the roster and the approved
revision are kept in the state.

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
| `local-only`   | No bucket is configured                                | A warning on every `fleet-sync`; run `--init`              |
| `empty`        | Neither side holds any state                           | `--import` a configuration                                 |
| `unpublished`  | The bucket holds nothing yet                           | The next change, or `--push`, seeds it                     |
| `local-ahead`  | This machine has changes the bucket has not received   | The next change, or `--push`, uploads them                 |
| `bucket-ahead` | Another manager changed the bucket; this copy is stale | The next change or `fleet-sync` takes the bucket's version |
| `unreachable`  | The bucket did not answer, or did not take an upload   | Changes still apply locally and are uploaded later         |
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
| The `fleet-sync` schedule                            | A launchd agent                                          | `fleet-sync --schedule enable`                                                                         |

Everything else under `~/.local/share/personal/fleet` and
`~/.local/state/personal/fleet` (run checkouts, reports, receipts, logs) is a
cache that the next `fleet-sync` rebuilds.

## Reference

| Setting                                                              | Meaning                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `DEVFLEET_STATE`                                                     | Another state directory. Earlier files are not read for it |
| `DEVFLEET_BUCKET`                                                    | Another `bucket.json`                                      |
| `DEVFLEET_BUCKET_ACCESS_KEY_ID`, `DEVFLEET_BUCKET_SECRET_ACCESS_KEY` | Credentials for `--init` when there is no terminal         |
| `DEVFLEET_CONFIG`                                                    | A configuration file that replaces the stored one          |

`bucket.json`:

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
written to its configuration, a report or a log. To rotate them, edit the file
or run `--init` again with the same bucket.

One bucket can hold several fleets under different prefixes. The database is
stored under `PREFIX/fleet.db/`. Each change adds a few kilobytes and Litestream
keeps thirty days of snapshots, so a restore to an earlier point is possible
with Litestream directly (with the bucket's keys in `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`):

```sh
mise exec litestream -- litestream restore -no-expand-env \
  -config ~/.local/share/dev-fleet/state/litestream.yml \
  -timestamp 2026-11-01T00:00:00Z -o /tmp/fleet-then.db \
  ~/.local/share/dev-fleet/state/fleet.db
```

Litestream is pinned in `mise.toml` and installed the first time it is used.
The manager is the only machine that runs it. There is one manager, so there is
one writer; two machines changing the state at the same moment are not
supported, only detected afterwards.
