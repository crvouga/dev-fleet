# What converges a machine, and what is not Ansible yet

The goal is one convergence engine: Ansible, on every platform, with the CLI
as an orchestrator that validates the fleet configuration, runs playbooks,
reads their results and reports checks. Today three mechanisms change a
machine: the playbooks under `ansible/`, the bootstrap scripts, and some
TypeScript. This page lists every step that is not an Ansible task yet, each
with the reason it is not, so the list can only shrink.
`features/rules/convergence.feature` fails when a file that changes a machine
is missing from it.

## Ansible

| Playbook                                  | Converges                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `ansible/ubuntu/baseline.yml`             | A worker's packages, Docker, services, power, user, SSH, disk                   |
| `ansible/ubuntu/tailscale.yml`            | Tailscale on a worker                                                           |
| `ansible/ubuntu/t3-desktop.yml`           | The T3 desktop app on a worker                                                  |
| `ansible/ubuntu/t3-policy.yml`            | T3's administrator policy                                                       |
| `ansible/ubuntu/t3-route.yml`             | T3's private tailnet route                                                      |
| `ansible/ubuntu/recovery.yml`             | Recovery of a stopped T3 desktop app                                            |
| `ansible/monitoring/agent.yml`            | The Beszel agent on a worker                                                    |
| `ansible/monitoring/agent-darwin.yml`     | The Beszel agent on the manager                                                 |
| `ansible/monitoring/hub-darwin.yml`       | The Beszel hub and its tunnel on the manager                                    |
| `ansible/monitoring/hub-route-darwin.yml` | The hub's private tailnet route                                                 |
| `ansible/macos/manager.yml`               | The manager's power settings                                                    |
| `ansible/macos/t3-policy.yml`             | T3's administrator policy on the manager                                        |
| `ansible/macos/manager-privilege.yml`     | The one `pmset -c` grant that lets fleet-sync hold the manager's power settings |
| `ansible/macos/worker-host-key.yml`       | A worker's pinned SSH host key in the manager's known_hosts                     |
| `ansible/github/git.yml`                  | The Git identity and GitHub credentials of every node                           |

Every playbook passes `ansible-lint` in the production profile, every command
in it says when it changes something and runs, or is skipped, in a dry run
(`features/rules/playbooks.feature`). The Beszel agent playbook is proven on a
systemd machine to report no change on a second run and in `--check`, and to
report drift, and only that drift (`features/monitoring/agent-lifecycle.feature`).

## Not Ansible yet

| Step                                                                                    | Where                                                                                       | Why it is not a task yet                                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Install Git, curl, CA certificates, Python and Ansible                                  | `bootstrap/fleet-remote-bootstrap.sh`                                                       | It must run before Ansible exists on the machine; it is the minimal bootstrap                                               |
| Create the worker account, its host key, the privilege rule and Tailscale on first boot | `bootstrap/worker-seed.yaml` (written by `fleet-node-seed`)                                 | cloud-init runs it before the manager can reach the machine; fleet-sync converges everything else with Ansible afterwards   |
| Install mise and the pinned toolchain                                                   | `bootstrap/bootstrap.sh`, `bootstrap/setup.ts`                                              | mise must exist before any tool does, and `mise install --locked` already converges from a lock                             |
| Install a worker's subset of tools                                                      | `bootstrap/worker-tools.ts`                                                                 | It chooses which locked tools `mise install` gets; moving it means a toolchain role                                         |
| Publish the global mise configuration                                                   | `bootstrap/global-config.ts`                                                                | Derived from `mise.toml` and the agent worktree roots on every run; a `toolchain` role with a template would replace it     |
| `PATH` lines in shell profiles                                                          | `bootstrap/shell-path.ts`                                                                   | Edits files a person owns, guarded by markers; a `blockinfile` task would replace it                                        |
| The `devfleet` launcher link                                                            | `bootstrap/install-launcher.sh`                                                             | Points at the fleet-owned checkout of the revision, known only during the run                                               |
| The T3 server archive                                                                   | `bootstrap/native-t3.ts`                                                                    | Installed with the toolchain, checked against the digest in `mise.toml`; a `t3` role would replace it                       |
| The AWS CLI on Windows                                                                  | `bootstrap/native-aws.ts`                                                                   | Windows is not a fleet role                                                                                                 |
| Docker Desktop on the manager                                                           | `bootstrap/docker-desktop.sh`                                                               | A person installs and approves it on macOS; dev-fleet only measures it                                                      |
| A worker's service credentials from Vault                                               | `bootstrap/worker-github.ts`, `bootstrap/worker-auth.ts`                                    | A login belongs to a machine and a person; it is read from a session, never declared                                        |
| The manager's own convergence: proxy, profiles, hub, agent                              | `src/cli/fleet-sync-manager.ts`                                                             | Orchestrates the manager playbooks and the proxy's own installer; the proxy is not a playbook yet (`docs/declared.md`)      |
| Scheduled runs                                                                          | `src/cli/fleet-sync-schedule.ts`, `src/platform/launchd.ts`, `src/platform/systemd-user.ts` | Writes a launchd job or systemd timer from TypeScript; listed in `docs/declared.md` as a schedule that should be a playbook |

## Still to do

Roles with a common interface (`baseline`, `toolchain`, `agents`, `t3`,
`network`, `monitoring`, `recovery`, `manager`), an inventory generated from
the fleet configuration, and `site.yml`, `manager.yml` and `workers.yml` that
bring a fresh manager and worker to ready with no other mutating step. Each
row of the table above moves into one of those roles.
