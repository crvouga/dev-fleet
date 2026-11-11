# Releasing

dev-fleet is published to npm as `@crvouga/dev-fleet`, so any machine or project
with Node can run it:

```sh
npx @crvouga/dev-fleet commands --json
npx @crvouga/dev-fleet fleet-status --local
```

The package ships the TypeScript sources, the Ansible policy, the bootstrap
scripts and the proxy scripts, because the CLI reads them at run time. Node
will not run TypeScript from `node_modules`, so the `devfleet` entry is a small
JavaScript launcher (`bin/devfleet.mjs`) that runs the CLI on the Bun this
release pins (a dependency of the package), falling back to a Bun on `PATH`.

`fleet-sync` pins a git revision of this repository and rebuilds every machine
from it, so it still needs a clone of the repository. Use `--workspace` or run
it from a clone; the npm package covers the rest of the CLI.

## What a release is

A release is a tag. Push `vX.Y.Z` and the [Release workflow](../.github/workflows/release.yml)
checks the commit, publishes `@crvouga/dev-fleet@X.Y.Z` with provenance and
creates the GitHub Release. `package.json` stays at `0.0.0-development`; the
workflow stamps the tag's version into the package it publishes, so nobody
edits a version or runs `npm publish` by hand after the one-time setup below.
Re-running a tag whose version is already on npm skips the publish.

```sh
git tag v0.1.0 && git push origin v0.1.0
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
commit npm recorded. Every step measures first and skips what is already done,
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

- `files` is an allow-list; tests and Python caches are excluded. `tests/package.test.ts`
  fails if a file the CLI reads is missing from the tarball.
- `bun` is a dependency pinned to the same version as `packageManager` and the
  `mise.toml` pin; bump the three together.
- The provenance statement links each version to the workflow run that built it.
