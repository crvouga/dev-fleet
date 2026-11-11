# What is declared, and where

Two machines given the same dev-fleet version and the same `fleet.json` should
end up the same. That holds only for what is written down in a tracked file,
pinned to an exact version or digest, applied by a tool that converges
(Ansible or mise) and measured afterwards. This page lists what is, and what
is not yet.

`features/rules/declared.feature` keeps the rules below true on every pull
request. Its tables of exceptions are the same as [not declared yet](#not-declared-yet), and
may only shrink.

## Declared

| What                                          | Declared in                                                                                         | Pinned by                                                            | Applied by                                                | Measured by                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| The fleet: machines, services, accounts       | Your `fleet.json`                                                                                   | The dev-fleet version in your `package.json`, which names one commit | `fleet-sync`                                              | `fleet-status`                               |
| Tools: languages, CLIs, coding agents         | `mise.toml`                                                                                         | `mise.lock`: version and checksum for each platform                  | `mise install --locked`                                   | Tool and `agent:verification` checks         |
| mise itself                                   | `min_version` and `mise_*_sha256` in `mise.toml`                                                    | The digest of its release archive, held here                         | `bootstrap/bootstrap.sh`                                  | Its version, at every toolchain setup        |
| JavaScript dependencies                       | `package.json`                                                                                      | `bun.lock`                                                           | `bun install --frozen-lockfile`                           | The install fails on a difference            |
| T3 Code, server and desktop app               | `t3_*` under `[vars]` in `mise.toml`                                                                | SHA-256 of each artifact                                             | `bootstrap/native-t3.ts`; `ansible/ubuntu/t3-desktop.yml` | T3 checks                                    |
| Ubuntu packages                               | `packages` and `snapshot` in `ansible/ubuntu/policy.json`                                           | Exact versions from a dated archive snapshot                         | `ansible/ubuntu/tasks/packages.yml`                       | `package:*`                                  |
| Tailscale on workers                          | `tailscale` in `ansible/ubuntu/policy.json`                                                         | Exact version; digest of the signing key                             | `ansible/ubuntu/tailscale.yml`                            | `package:tailscale`                          |
| Worker policy: power, SSH, sudo, memory, disk | `ansible/ubuntu/*.yml`, values shared with checks in `policy.json`                                  | The commit                                                           | `fleet-sync`                                              | Host and resource checks                     |
| Monitoring: hub, tunnel, agents               | `ansible/monitoring/*.yml`, `compose.yml`, `lock.json`                                              | Image digests; SHA-256 of each agent archive                         | `fleet-sync`                                              | `beszel:*`                                   |
| The manager's private route to the hub        | `ansible/monitoring/hub-route-darwin.yml`                                                           | The commit                                                           | `fleet-sync`                                              | The route, read back                         |
| The manager's power settings                  | `pmset` in `ansible/macos/policy.json`                                                              | The commit                                                           | `ansible/macos/manager.yml`, once, as an administrator    | `manager:power`                              |
| Ansible on the manager                        | `ansible/pyproject.toml`                                                                            | `ansible/uv.lock`: one release, one Python, every dependency hashed  | `uv run --locked --isolated`                              | A hash that differs stops the run            |
| Ansible on a worker                           | `ansible-core` in `ansible/ubuntu/policy.json`                                                      | Exact version                                                        | `ansible/ubuntu/tasks/packages.yml`                       | `package:ansible-core`                       |
| The CLI proxy                                 | `cliproxy/compose.yaml`, `image.lock.json`, `requirements.lock`, `launchd/`, `config.template.yaml` | Image digests; hashed Python dependencies                            | `devfleet cliproxy install`, and `fleet-sync` after it    | The proxy's audit                            |
| Agent profiles and T3 providers               | `agents/registry.json`, `agents/t3.json`                                                            | The commit                                                           | `fleet-sync`                                              | Profile receipts; the plan after every apply |
| Docker Desktop on the manager                 | `docker_desktop_*` under `[vars]` in `mise.toml`                                                    | Version and build                                                    | You                                                       | `manager:docker` (warns)                     |
| CI                                            | `.github/workflows/`                                                                                | Each action at a commit; tools from `mise.lock`                      | GitHub                                                    | `features/rules/`                            |

A value lives in a policy file when something besides the playbook reads it,
so the check and the playbook cannot disagree. A value only a playbook uses
stays in the playbook: the playbook is its declaration.

## Not declared yet

- **A schedule.** Nothing re-applies the fleet on a timer, so a machine drifts
  until someone runs `fleet-sync`. `fleet-sync --schedule enable` writes a
  launchd job from TypeScript and has never worked from the published package.
  It should become a playbook.
- **The rest of a worker's packages.** Only the packages in `policy.json` are
  exact. `systemd-oomd` and the T3 desktop libraries are installed at whatever
  version the machine's own archive holds, and the machine's own updates move
  everything else. Pinning them needs every worker on the snapshot with its
  own updates off, so security fixes arrive only when the snapshot moves. That
  is a policy choice, not a missing line.
- **What a worker needs before Ansible exists.** `fleet-remote-bootstrap.sh`
  installs Git, curl, CA certificates, Python and `ansible-core` from the
  machine's own archive (the snapshot is HTTPS, and a new machine has no CA
  certificates yet). The baseline then pins each of them.
- **The manager's applications.** Docker Desktop, Tailscale and Apple's
  Command Line Tools are installed by a person. Docker Desktop is measured;
  the other two are only required.
- **The CLI proxy's lifecycle.** It is installed and started by its own Python
  scripts from the declarative files above, not by a playbook.
- **Files TypeScript and shell still write.** The installed `fleet.json`, the
  `current` and `devfleet` links, the `PATH` lines in shell profiles, the
  global mise configuration, the T3 server archive, agent profiles and T3
  settings. Each is derived
  from a tracked file and rewritten on every run, but by code.
- **Logins.** Tailscale, Vault, GitHub, each provider account and T3 pairing
  belong to a machine and a person. They are checked, never copied.
- **Windows.** `bootstrap/bootstrap.ps1` exists; Windows is not a fleet role
  and nothing tests it.

## Why not Nix

Nix would give the same three things this has: pinned inputs, verified
artifacts and a declarative description of the machine. Here they come from
`mise.lock`, the Ubuntu snapshot and Ansible. Adding Nix would put a second
package universe on every machine beside the one that is already running, and
moving to it entirely means NixOS workers and nix-darwin on the manager, which
replaces every unit and path that exists today. The one thing above that Nix
would settle and the current tools do not is the rest of a worker's packages.

## Changing a pin

| To change               | Edit                                                                 | Then                                             |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| A tool                  | Its version in `mise.toml`                                           | Update `mise.lock` with `mise lock`              |
| mise                    | `min_version` and the four `mise_*_sha256` in `mise.toml`            | Copy the digests from the release's `SHASUMS256` |
| An Ubuntu package       | `packages` in `ansible/ubuntu/policy.json`, and `snapshot` if needed | The VM test in `ansible/ubuntu/tests`            |
| Ansible on the manager  | `ansible/pyproject.toml`                                             | `uv lock` in `ansible/`                          |
| Beszel                  | `ansible/monitoring/lock.json`, `compose.yml`, the agent unit        | `bun test features/rules`                        |
| A manager power setting | `pmset` in `ansible/macos/policy.json`                               | Run `manager.yml` once on the manager            |
