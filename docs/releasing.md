# Releasing

dev-fleet is published to npm as `@crvouga/dev-fleet`. The package is how
dev-fleet is used: a fleet is a project that depends on it and runs `devfleet`
from there (see the [README](../README.md#how-you-use-it)). Nobody clones this
repository to run a fleet.

```sh
npm install --save-dev --save-exact @crvouga/dev-fleet
npx devfleet fleet-sync
```

The package ships the TypeScript sources, the Ansible policy, the bootstrap
scripts and the proxy scripts, because the CLI reads them at run time. Node
will not run TypeScript from `node_modules`, so the `devfleet` entry is a small
JavaScript launcher (`bin/devfleet.mjs`) that runs the CLI on the Bun this
release pins (a dependency of the package), falling back to a Bun on `PATH`.

Machines do not run the package. `fleet-sync` rebuilds every machine from one
git commit of this repository, and the package says which: the Release
workflow writes the commit it publishes from into the package's `package.json`
as `gitHead` ([`src/package-info.ts`](../src/package-info.ts) reads it). Run
from the package, `fleet-sync` fetches that commit from the repository
`fleet.json` names under `source` into a cache the manager owns, and converges
the manager and every worker from checkouts of it. So a version of the package
is a revision of the fleet, and the commit a release names must stay reachable
in the source repository.

## What a release is

Every merge to `main` is a release. When CI passes on `main`, the
[Release workflow](../.github/workflows/release.yml) picks the next version from
the commits since the newest `vX.Y.Z` tag (or, before there is one, the newest
version on npm)
([`bootstrap/release-version.ts`](../bootstrap/release-version.ts)), publishes it
to `@crvouga/dev-fleet` with provenance, pushes the tag and creates the GitHub
Release. The commit messages choose the bump:

| Commits since the last tag                     | Bump                                 |
| ---------------------------------------------- | ------------------------------------ |
| any `feat!:`, `fix(x)!:` or `BREAKING CHANGE:` | major (minor while the major is `0`) |
| otherwise any `feat:`                          | minor                                |
| otherwise                                      | patch                                |

`package.json` stays at `0.0.0-development` and carries no `gitHead`; the
workflow stamps the version and the commit into the package it publishes, so
nobody edits a version or runs `npm publish` by hand after the one-time setup
below. Merges that land while a release runs
wait, and the newest one releases everything since the last tag. A run that
cannot release because publishing was never set up (no tag and nothing on
npm) fails, and the run summary says why; a merge with nothing new to release
passes and says so. Re-running a
release whose version is already on npm skips the publish and finishes the tag
and GitHub Release.

Nothing is published until the release has been tried. The workflow packs
the package once, then, for that commit and that tarball:

- installs the tarball in an empty directory, the way a fleet project does,
  and runs `devfleet --version` and `devfleet fleet-state --example` on Node
  22 and 24 ([`bootstrap/package-smoke.ts`](../bootstrap/package-smoke.ts)):
  a broken bin path or a file missing from `files` fails here;
- runs the [Ubuntu VM test](../.github/workflows/vm.yml) (a real Ubuntu
  machine: baseline, a second run, drift, reboot, and the production SSH
  bootstrap of the commit).

Only when both pass is that same tarball published, and the GitHub Release
gets notes written from the Conventional Commits since the last release
([`bootstrap/release-notes.ts`](../bootstrap/release-notes.ts)). A commit
whose change restarts T3 on the workers, and so ends the agent turns running
there, says so in a `Worker-Restart: <reason>` footer, and the notes list it
first.

There is no `next` channel yet: publishing uses npm Trusted Publishing, which
can publish but cannot move a dist-tag, and moving one would need an npm
token stored in CI. The VM test before publishing stands in for the soak a
`next` channel would give.

A hand-pushed tag still works and publishes exactly that version:

```sh
git tag vX.Y.Z && git push origin vX.Y.Z
```

CI never receives an npm token: it publishes through npm Trusted Publishing
(OIDC).

## One-time setup

npm can publish new versions through OIDC but cannot create a package that does
not exist yet. One command does the one-time work with your own npm login, from
`main` with a clean tree:

```sh
bun run bootstrap
```

It signs in to npm (browser approval), runs `bun run check`, publishes `0.1.0`
from a throwaway checkout of `HEAD` (so your working tree is never edited),
makes `release.yml` the package's trusted publisher, and tags `v0.1.0` on the
commit npm recorded. When npm recorded none (as for the `0.1.0` that is on
npm), there is nothing to tag: until the first tag exists, the Release
workflow counts from the newest version on npm and every commit up to `HEAD`
picks the bump. Every step measures first and skips what is already done,
so run it again after any interruption. It needs npm 11.10 or newer (for
`npm trust`) and an npm account that owns the `@crvouga` scope. Flags: `--yes`
skips the confirmation, `--skip-check` skips `bun run check`.

Verify from a machine that has never seen the package:

```sh
npx --yes @crvouga/dev-fleet --version
```

If `npm trust` is unavailable, set the publisher in the browser instead:
<https://www.npmjs.com/package/@crvouga/dev-fleet/access> → Trusted Publisher →
GitHub Actions → organization `crvouga`, repository `dev-fleet`, workflow
filename `release.yml`, environment empty.

## Why the package looks like this

- `files` is an allow-list; tests and Python caches are excluded. `features/rules/package.feature`
  fails if a file the CLI reads is missing from the tarball.
- `bun` is a dependency pinned to the same version as `packageManager` and the
  `mise.toml` pin; bump the three together.
- The provenance statement links each version to the workflow run that built it.
