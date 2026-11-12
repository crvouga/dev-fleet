# GitHub on every node

Every node, the manager and each worker, signs in to GitHub from a stored
credential. Nobody runs `gh auth login` on a node, and no login directory is
copied between machines.

## Where the token is

The token is the declared secret `github-token`, read through the secrets
provider your `fleet.json` names, like every other secret:

| Provider | Shared token                                                              | Per-node token (`"credential": "per-node"`) |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| `env`    | `DEVFLEET_SECRET_GITHUB_TOKEN`                                            | `DEVFLEET_SECRET_GITHUB_TOKEN_<NODE>`       |
| `file`   | `github-token`                                                            | `github-token-<node>`                       |
| `sops`   | key `github-token`                                                        | key `github-token-<node>`                   |
| `vault`  | `locations["github-token"]`, or field `GITHUB_TOKEN` beside the proxy key | the same location, field `<FIELD>_<NODE>`   |

The login it must belong to is `worker.githubLogin`.

## The `github` block

All of it is optional:

```json
"github": {
  "manager": "fleet",
  "credential": "shared",
  "scopes": ["repo", "workflow"],
  "repositories": ["example-org/app"],
  "organizations": ["example-org"],
  "sandbox": "example-org/sandbox"
}
```

- `manager`: `"fleet"` (the default) signs the manager in as the fleet login,
  like a worker. `{ "login": "…" }` names a person's own login: it is checked
  and never replaced.
- `credential`: `"shared"` (one token) or `"per-node"` (one per node, so one
  can be revoked alone and nodes do not share a rate limit).
- `scopes`, `repositories`, `organizations`: what `github:permissions` and
  `github:org-access` hold the token to.
- `sandbox`: the repository `fleet-github-verify` may use.

## How a node is signed in

`bootstrap/worker-github.ts` runs at every `fleet-sync` and, on a worker, every
ten minutes from the user timer `personal-worker-github`. It is apart from the
Vault renewal (`personal-worker-auth`): one failing never stops or hides the
other. It signs gh in with the stored token when the node is not signed in, or
when the stored token differs from the one gh holds and is valid for the
declared login. git asks gh for the token at every use
(`credential.https://github.com…helper = !gh auth git-credential`, set by
`ansible/github/git.yml` with the identity of the `git` block on every node),
so a replaced token reaches git with no change and no second copy on disk.

A `fleet-sync` fails with `github:sync` when the node cannot be signed in.

## Rotating the token

1. Issue a new token for the fleet login and put it in the store as
   `github-token`.
2. Run `fleet-sync` (the canary worker first, as always), or wait up to ten
   minutes for every node's timer. Each node adopts the new token while the old
   one still works.
3. When `github:token-current` passes on every node, revoke the old token.

## Checks

| Check                   | What it says                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth:github`           | gh answers `auth status` in this context.                                                                                                                               |
| `github:principal`      | The node is signed in as its declared login (the fleet login, or the manager's personal one).                                                                           |
| `github:token-current`  | The node uses the token the store holds now (`GITHUB_TOKEN_STALE` otherwise). Not reported for a personal login.                                                        |
| `github:permissions`    | The token has every declared scope and can push to every declared repository (`GITHUB_PERMISSION_MISSING: …`). Warns for a fine-grained token, which reports no scopes. |
| `github:expiry`         | Warns 14 days before the token expires, fails 3 days before.                                                                                                            |
| `github:rate-limit`     | Warns below 20 % of the rate limit left, with the reset time.                                                                                                           |
| `github:org-access`     | Single sign-on has authorised the token for each declared organisation.                                                                                                 |
| `github:git-credential` | git asks gh for its GitHub credential.                                                                                                                                  |
| `worker:github-sync`    | Why a worker is not signed in: `GITHUB_TOKEN_MISSING`, `GITHUB_TOKEN_REJECTED`, `GITHUB_LOGIN_MISMATCH`, `GITHUB_UNREACHABLE`.                                          |
| `auth:copilot`          | Copilot CLI uses the node's GitHub sign-in; fails `not-signed-in` without one and `COPILOT_TOKEN_UNSUPPORTED` for a classic token.                                      |
| `github:workflow`       | From `fleet-github-verify`: the first step of clone, branch, commit, push, pull request, checks and comment that failed.                                                |

## Copilot CLI

Copilot CLI takes the token gh holds when it has none of its own, so the
node's GitHub sign-in is its sign-in. It accepts OAuth, GitHub App user and
fine-grained tokens with the Copilot Requests permission, not classic
personal access tokens. Whether the account is entitled to Copilot is not
measured; no prompt is sent.

## Verifying the whole workflow

`devfleet fleet-github-verify` runs, from the machine it is started on, what an
agent does on the sandbox repository: clone, a uniquely named branch, an empty
commit with the configured identity, push, a draft pull request, a read of its
checks, a comment. It then closes the pull request and deletes the branch,
whatever failed, and reports anything it could not remove.

## Not yet

- Short-lived GitHub App installation tokens minted by the manager.
- A container registry, package registry and tool installer adapter: today
  only git takes its credential from gh.
- A launchd timer for the manager: it is signed in at every `fleet-sync`.
- `fleet-github-verify` runs on the machine it is started on; `--node` and a
  scheduled run are not there yet.
