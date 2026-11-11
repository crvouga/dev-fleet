# Bugs and feature requests

This file ships inside the dev-fleet package. If you are an agent working in
another project and dev-fleet is wrong or lacks something, do not edit it
here, in a clone or on a machine. Raise an issue in the dev-fleet repository;
`devfleet --help` prints the address and `devfleet commands --json` carries
the rule under `agent.support`.

# Manager-led Ubuntu fleet setup

For the enrolled Ubuntu development fleet, run on the designated manager:

```sh
devfleet fleet-sync
```

Read the [Fleet operator guide](../../fleet/docs/ubuntu-sync.md) for enrollment,
approved revisions, bootstrap, provider checks and unresolved release gates.
Routine fleet updates do not require a command sequence on individual nodes.
The legacy local commands below retain their existing behavior for compatibility.

# Developer fleet configuration setup

Use **personal** for node and T3 configuration. Workstation and fleet are internal
implementation packages; neither exports its own executable.

`fleet-sync` installs the `devfleet` launcher on every machine it converges,
linked to the fleet-owned checkout of the applied revision. On such a machine:

```sh
devfleet fleet-status
```

`fleet-node-sync` reconciles one machine from a checkout of dev-fleet
(`--workspace PATH` or `PERSONAL_WORKSPACE` names it). It is for development:
run from the published package it is refused, because `fleet-sync` does the
same from a checkout it owns.
Each machine still needs its own authorized Vault session, SSH keys and T3 pairing.
The sync never copies them or provisions infrastructure.

## Reconciliation

`fleet-node-sync` applies by invocation. It reconciles the locked toolchain, installs
one `personal` launcher, retires the repository-owned `ws` launcher, upserts the
Codex proxy profile, and reconciles T3 provider instances. `--dry-run` lists these
steps without writing or installing. The default node ID is the normalized hostname;
use `--id NAME` to retain an existing node's registry overrides.

The selected revision defaults to checkout HEAD. `--revision FULL_SHA` pins a
reviewed commit already fetched into that checkout. Deployment uses a clean Git
worktree and preserves developer edits. For whole-fleet maintenance, use the manager command above; this legacy local route does not orchestrate other nodes. A failed step stops later steps and reports
partial progress; it never claims authentication or inference was verified.

Portable models live in `agents/registry.json`; T3 desired provider instances live
in `agents/t3.json`. Edit these tracked definitions and deploy a reviewed revision.
New sessions use the updated configuration. Running sessions are not restarted.

## T3 plan, apply, import and cleanup

```sh
devfleet t3-apply --dry-run --json
devfleet t3-apply
devfleet t3-status
devfleet t3-cleanup --dry-run
```

Plans show create/update/delete/unchanged/conflict by instance ID, with no settings
values or credentials. `devfleet t3-apply --plan-hash HASH` binds apply to the exact
settings, ownership state, desired definitions and destination reviewed in a plan.
A stale plan fails. A second apply with identical inputs performs no settings write.

A provider instance becomes managed when created by personal, or explicitly imported:

```sh
devfleet t3-apply --import personal_grok_proxy
devfleet t3-apply
```

Import grants ownership of the entire named provider instance. It does not change
its settings immediately. Subsequent applies reconcile that instance to the tracked
definition, including removal of extra fields. Existing unowned instances cause a
conflict, even when their names match. Unrelated instances and settings are preserved.

Removing an instance from the desired definition removes it on the next apply.
`devfleet t3-cleanup` removes **all owned provider instances** while retaining
threads, projects, pairing, native provider instances, credentials and profile files.
It does not delete T3's data directory or secret store. Historical threads may need
a replacement provider selected after their managed instance is removed.

`--t3-home PATH` selects a T3 base directory (otherwise T3CODE_HOME or ~/.t3).
`--definition FILE` selects a version-1 desired definition. Supported interpolation
is `${workspace}`, `${agents}` and `${node}`. The current schema deliberately supports
the verified Codex proxy adapter fields; it rejects inline credential definitions.
T3 proxy execution requires macOS/Linux/WSL; native Windows execution is unverified.

## State and concurrency

T3 owns `userdata/settings.json`. Personal merges only its declared instances and
stores IDs in `userdata/personal-managed.json`, with mode 0600. Private settings and
state backups sit beside that file. They may contain existing secret references or
values and must never enter Git or reports. Symlink/malformed destinations fail.

Personal operations use an exclusive lock, atomic replacement, pre-write freshness
checks and post-write verification. T3's own theme CLI uses the same optimistic
external-file update pattern; T3 does not honor personal's lock. Avoid concurrent
Settings edits during apply: there is no cross-process atomic compare-and-swap with
T3. No strict transaction across application and ownership files is claimed. Ownership
intent is saved before settings so interrupted creates/removals can be retried.
Inspect interrupted operations before removing a stale `.lock` directory.

T3's installed server source at revision
`322f6544dfad0a3c8a0c8cbecf2c7f7874b14268` was inspected for provider-instance shape,
external settings watch/reload, and optimistic CLI writes. Future T3 schema changes
require adapter verification. A disk-level success is not a live inference test.

## Supported alternatives

`PROVIDER_PROTOCOL_INCOMPATIBLE` means the gateway answered that it has no
endpoint, method or media type for the protocol a route speaks (HTTP 404, 405,
415 or 501). The route as declared cannot work, so the check fails and the
sync exits nonzero; signing in again or retrying changes nothing. Nothing on
the machine is changed to work around it.

The protocol a tool speaks to the proxy is its `proxy` field in
`agents/registry.json` (`responses`, `messages`, `generateContent` or
`chat_completions`). The supported alternatives, in this order:

1. A model the proxy lists at `/v1/models` for the same protocol: change the
   tool's model in `agents/registry.json`.
2. Another protocol the tool's own CLI speaks and the pinned proxy serves.
   `chat_completions` is served for OpenAI-compatible clients such as
   OpenCode and Grok.
3. The tool's direct profile, signed in natively on that machine, instead of
   the shared proxy.

Each is a reviewed change to a tracked file, followed by `devfleet
fleet-sync`. A newer CLIProxyAPI is a reviewed change to
`cliproxy/image.lock.json`; a sync never upgrades it to get around a failure.

A model that is merely missing from the catalog is `PROVIDER_MODEL_UNAVAILABLE`
instead: a warning, because it is usually the provider account's (billing or
access), not the route's.

## Other local operations

All former workstation operations are available through `dev-fleet`:

```sh
dev-fleet tools check --json
bun src/agents/cli.ts agents verify --node NODE --tool codex --profile proxy --json
dev-fleet opencode sync
dev-fleet net check
```

`devfleet fleet-status` diagnoses the manager and registered remote nodes.
`devfleet fleet-discover` lists visible Tailscale computers. The local SSH roster
still requires real aliases and checkout paths; discovery never guesses these.
Use `personal commands --json` to discover the complete interface.
