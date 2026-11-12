# Authentication and accounts

Where each credential dev-fleet uses lives, who can read it, how it reaches
each node, how it rotates and what happens when it fails. The three tables
are generated from the code; `features/rules/authentication.feature` fails
when one is out of date (`DEVFLEET_UPDATE_DOCS=1 bun test features/rules`
rewrites them).

## Where credentials live

| Credential                          | Lives in                                                                                                                      | Read by                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| The fleet's secrets (table below)   | The provider `secrets` names in `fleet.json`                                                                                  | The node that needs it, through `src/secrets.ts` |
| The bucket's two keys               | The environment of the `devfleet` command; `~/.config/dev-fleet/bucket.json` (0600) on the manager after `fleet-state --init` | The manager only                                 |
| A node's Vault token                | That node's own Vault session (`~/.vault-token`)                                                                              | That node only; never copied                     |
| A node's GitHub login               | `gh`'s own store on that node                                                                                                 | `gh`, and git through its credential helper      |
| Provider accounts (Claude, Codex …) | The CLI proxy's store on the manager                                                                                          | The proxy; nodes hold only the proxy client key  |
| Tailscale and T3 pairing            | Each machine, signed in by a person                                                                                           | That machine                                     |

## How they reach each node

- **Vault.** A person logs each machine in once (`fleet-sync` asks on the
  manager and passes the password to the worker over SSH on standard input).
  From then on the worker's `personal-worker-auth` timer renews its own token
  (`bootstrap/worker-auth.ts`). Nothing renders provider configuration from
  Vault on a worker: agent profiles come from `fleet-sync`.
- **GitHub.** The same job restores the declared account (`worker.githubLogin`)
  with the GitHub service token it reads from its own Vault session
  (`bootstrap/worker-github.ts`, on standard input, never argv). `fleet-sync`
  makes `gh` git's credential helper and writes the declared identity
  (`git` in `fleet.json`, `ansible/github/git.yml`) on every node.
- **The proxy client key** is read by each node from its own secrets provider
  whenever a launcher starts an agent.
- **The monitoring hub's backup storage keys** are read on the manager by
  `fleet-sync` and handed to the hub's playbook in a private variables file.

## Rotation and failure

Rotate a secret where the provider keeps it; the next read uses it, nothing
caches it. A Vault token that is not renewed expires: `worker:vault-renewal`
fails and the fix is one login of that machine. A GitHub token that stops
working fails `auth:github` and `worker:git-push-auth`; store the new one in
Vault and the worker restores itself within ten minutes. During a proxy
outage agents on workers wait: no worker is configured for native clients.
Every failure code is in [the runbooks](runbooks.md).

## The fleet's secrets

<!-- generated: secrets -->

| Secret                         | Required                     | `env` provider variable                        | `file` provider file                                       |
| ------------------------------ | ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `proxy-client-key`             | yes                          | `DEVFLEET_SECRET_PROXY_CLIENT_KEY`             | `~/.config/dev-fleet/secrets/proxy-client-key`             |
| `monitoring-account-password`  | yes                          | `DEVFLEET_SECRET_MONITORING_ACCOUNT_PASSWORD`  | `~/.config/dev-fleet/secrets/monitoring-account-password`  |
| `monitoring-tunnel-token`      | yes                          | `DEVFLEET_SECRET_MONITORING_TUNNEL_TOKEN`      | `~/.config/dev-fleet/secrets/monitoring-tunnel-token`      |
| `proxy-tunnel-token`           | yes                          | `DEVFLEET_SECRET_PROXY_TUNNEL_TOKEN`           | `~/.config/dev-fleet/secrets/proxy-tunnel-token`           |
| `github-token`                 | when its feature is declared | `DEVFLEET_SECRET_GITHUB_TOKEN`                 | `~/.config/dev-fleet/secrets/github-token`                 |
| `monitoring-backup-access-key` | when its feature is declared | `DEVFLEET_SECRET_MONITORING_BACKUP_ACCESS_KEY` | `~/.config/dev-fleet/secrets/monitoring-backup-access-key` |
| `monitoring-backup-secret-key` | when its feature is declared | `DEVFLEET_SECRET_MONITORING_BACKUP_SECRET_KEY` | `~/.config/dev-fleet/secrets/monitoring-backup-secret-key` |
| `notify-webhook-url`           | when its feature is declared | `DEVFLEET_SECRET_NOTIFY_WEBHOOK_URL`           | `~/.config/dev-fleet/secrets/notify-webhook-url`           |
| `notify-ntfy-url`              | when its feature is declared | `DEVFLEET_SECRET_NOTIFY_NTFY_URL`              | `~/.config/dev-fleet/secrets/notify-ntfy-url`              |
| `tailnet-auth-key`             | when its feature is declared | `DEVFLEET_SECRET_TAILNET_AUTH_KEY`             | `~/.config/dev-fleet/secrets/tailnet-auth-key`             |
| `tailnet-admin`                | when its feature is declared | `DEVFLEET_SECRET_TAILNET_ADMIN`                | `~/.config/dev-fleet/secrets/tailnet-admin`                |

<!-- end: secrets -->

## Checks of credentials

<!-- generated: checks -->

| Check                         | Measured in                                |
| ----------------------------- | ------------------------------------------ |
| `auth:github`                 | `src/github/checks.ts`                     |
| `auth:vault`                  | `src/cli/fleet-sync-vault.ts`              |
| `auth:vault-isolation`        | `src/cli/fleet-sync-vault.ts`              |
| `worker:git-identity`         | `src/git-identity.ts`                      |
| `worker:git-push-auth`        | `src/definition.ts`, `src/git-identity.ts` |
| `worker:git-signing`          | `src/definition.ts`, `src/git-identity.ts` |
| `worker:github-sync`          | `src/worker-access-checks.ts`              |
| `worker:proxy-authentication` | `src/worker-access-checks.ts`              |
| `worker:vault-renewal`        | `src/worker-access-checks.ts`              |

<!-- end: checks -->

## Timers

<!-- generated: timers -->

| Timer                            | Declared in                            | Schedule                              |
| -------------------------------- | -------------------------------------- | ------------------------------------- |
| `personal-fleet-disk-gc.timer`   | `ansible/ubuntu/tasks/resources.yml`   | OnBootSec=10min, OnCalendar=hourly    |
| `personal-worker-auth.timer`     | `ansible/ubuntu/tasks/credentials.yml` | OnBootSec=2min, OnUnitActiveSec=10min |
| `personal-worker-github.timer`   | `ansible/ubuntu/tasks/github.yml`      | OnBootSec=2min, OnUnitActiveSec=10min |
| `personal-worker-recovery.timer` | `ansible/ubuntu/tasks/recovery.yml`    | OnBootSec=1min, OnUnitActiveSec=1min  |
| `personal-worker-recovery.timer` | `ansible/ubuntu/tasks/recovery.yml`    | OnBootSec=5min, OnUnitActiveSec=15min |

<!-- end: timers -->
