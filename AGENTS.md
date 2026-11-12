# Agent notes

- dev-fleet keeps one macOS **manager** and Ubuntu **workers** in sync. Use
  exactly those words. Read `README.md` first.
- **Nobody clones this repository to run a fleet.** dev-fleet is used as the
  published package, from a consumer's project that holds its `fleet.json`
  and pins the package version. The package names the commit it was published
  from (`src/package-info.ts`); machines run fleet-owned checkouts of that
  commit, fetched from the source repository. Nothing may depend on a clone,
  on the directory the CLI was started in, or on where a package manager put
  the package: no path into them is ever written to a machine. A checkout is
  for developing dev-fleet only.
- **Agents in other projects ask; they never patch.** From a consumer's
  project a change to dev-fleet is a GitHub issue in this repository, and the
  tool tells them so: the tracker is `bugs` in `package.json`, printed by
  `devfleet --help` and carried with the rule in the agent contract
  (`support` in `src/cli/agent-guide.ts`). Keep that text true when the way a
  change is requested changes. Issues are public and come from other fleets:
  never copy a hostname, account or domain from one into a tracked file.
- **The package is a command, not a library.** It declares no `main` or
  `exports` and nothing under `src/` is a supported import
  (`features/rules/package.feature`). A consumer that needs a building block
  asks for a command. On a fleet machine the global mise configuration is
  dev-fleet's; a project pins its tools in its own `mise.toml`.
- **No fleet's identity in this repository.** No account, email, hostname,
  domain, tailnet name or consumer repository in tracked files; they belong in
  the consumer's `fleet.json`, read only through `src/fleet-config.ts`
  (`cliproxy/scripts/fleet_config.py` for the proxy scripts).
  `features/rules/identity.feature` enforces this.
- **Declare, then measure.** Anything that changes a machine is an Ansible task
  (`ansible/`, builtin modules only) or a mise pin. TypeScript refuses
  conflicts beforehand and measures the result afterwards; it must not run
  `systemctl start|restart|enable`, `tailscale serve`, `apt` or similar itself.
  A version or digest is written once, in a lock or policy file
  (`mise.toml`, `mise.lock`, `ansible/*/policy.json`,
  `ansible/monitoring/lock.json`, `ansible/uv.lock`), never in a script or in
  TypeScript. `features/rules/declared.feature` enforces this and `docs/declared.md`
  lists what is not declared yet: add to neither list.
- **Text written to machines is an interface.** Managed-file contents, unit
  names, launchd labels, state paths and ownership markers already exist on
  running machines. Changing one is a migration, never a rename. An ownership
  check compares the marker text only, never a path or repository name.
- **The bucket is the source of truth; local data is disposable.** State the
  manager cannot rebuild from Git is a document in the fleet state
  (`src/state/`, see `docs/state.md`), changed through `mutateState` or
  `refresh` then `push`, never a new file under the home directory. The
  configuration says where the bucket is and every command is passed its
  credentials in the environment (`src/state/connection.ts`). Only the
  devfleet CLI reads the state and looks for a project's `fleet.json`;
  launchers and the worker probe run under Node and use the copy fleet-sync
  installs, so nothing they import may load `bun:sqlite`.
- Secrets are read by purpose through `src/secrets.ts`. Never put a secret in
  argv, a report, a log or the fleet configuration.
- Diagnostics are read-only. Use stable check IDs and structured remedies;
  never serialize raw subprocess output, environment, SSH config or auth
  responses.
- Keep the CLI flat: `fleet-*`, `t3-*`, `cliproxy`. Add flags, not aliases or
  nested groups.
- **Behaviour is specified in Gherkin.** Every test of the TypeScript is a
  scenario under `features/` (read `features/README.md` first): the feature
  says what is true in the product's words and carries its inputs and expected
  values; the step definitions beside it hold the mechanics. Do not add a
  `*.test.ts` that is not an area's `features.test.ts`. Scenarios inject every
  subprocess, run against `examples/fleet.json` (without the bucket it names)
  and never contact a real machine. Run `bun run check` before pushing. Verify
  bootstrap changes with `DEVFLEET_TEST_FRESH_BOX=1 bun test
features/fresh-box`, which bootstraps a disposable Ubuntu machine over SSH
  from the `HEAD` commit; CI runs it on every pull request.
- **A pull request merges itself and is released; what breaks on `main` is an
  issue.** Open the pull request ready (a draft is never merged), with a
  Conventional Commits title: it becomes the squash commit and picks the
  version. It merges when the one required check passes, CI runs again on
  `main` and the release follows (`features/rules/pull-requests.feature`).
  Before starting work, read the open issues labelled `ci-failure`: each is a
  workflow failing on `main` now, kept current by `failures.yml` and closed
  by the first passing run. Never close one by hand; fix it with a pull
  request that says `Fixes #<issue>`. Something you find and do not fix is an
  issue too, not a note in a pull request.
