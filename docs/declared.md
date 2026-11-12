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

| What                                          | Declared in                                                                                         | Pinned by                                                            | Applied by                                                                                    | Measured by                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| The fleet: machines, services, accounts       | Your `fleet.json`                                                                                   | The dev-fleet version in your `package.json`, which names one commit | `fleet-sync`                                                                                  | `fleet-status`                                                  |
| Tools: languages, CLIs, coding agents         | `mise.toml`                                                                                         | `mise.lock`: version and checksum for each platform                  | `mise install --locked`                                                                       | Tool and `agent:verification` checks                            |
| mise itself                                   | `min_version` and `mise_*_sha256` in `mise.toml`                                                    | The digest of its release archive, held here                         | `bootstrap/bootstrap.sh`                                                                      | Its version, at every toolchain setup                           |
| JavaScript dependencies                       | `package.json`                                                                                      | `bun.lock`                                                           | `bun install --frozen-lockfile`                                                               | The install fails on a difference                               |
| T3 Code, server and desktop app               | `t3_*` under `[vars]` in `mise.toml`                                                                | SHA-256 of each artifact                                             | `bootstrap/native-t3.ts`; `ansible/ubuntu/t3-desktop.yml`                                     | T3 checks; `t3:version` on every machine                        |
| T3 policy on the manager (updates off)        | `ansible/ubuntu/t3/policy.json`, shared with the workers                                            | The commit                                                           | `ansible/macos/t3-policy.yml`, once, as an administrator (`manager-privilege.yml`)            | `t3:updates`                                                    |
| Worker work-in-progress guard                 | `ansible/ubuntu/wip-guard.py`, `ansible/ubuntu/tasks/recovery.yml`                                  | The commit                                                           | `fleet-sync`                                                                                  | `features/ide/work-in-progress.feature`                         |
| Ubuntu packages                               | `packages` and `snapshot` in `ansible/ubuntu/policy.json`                                           | Exact versions from a dated archive snapshot                         | `ansible/ubuntu/tasks/packages.yml`                                                           | `package:*`                                                     |
| Tailscale on workers                          | `tailscale` in `ansible/ubuntu/policy.json`                                                         | Exact version; digest of the signing key                             | `ansible/ubuntu/tailscale.yml`                                                                | `package:tailscale`                                             |
| Worker policy: power, SSH, sudo, memory, disk | `ansible/ubuntu/*.yml`, values shared with checks in `policy.json`                                  | The commit                                                           | `fleet-sync`                                                                                  | Host and resource checks                                        |
| Monitoring: hub, tunnel, agents               | `ansible/monitoring/*.yml`, `compose.yml`, `lock.json`                                              | Image digests; SHA-256 of each agent archive                         | `fleet-sync`                                                                                  | `beszel:*`                                                      |
| The manager's private route to the hub        | `ansible/monitoring/hub-route-darwin.yml`                                                           | The commit                                                           | `fleet-sync`                                                                                  | The route, read back                                            |
| The manager's power settings                  | `pmset` in `ansible/macos/policy.json`                                                              | The commit                                                           | `ansible/macos/manager.yml`, on every `fleet-sync`, after one grant (`manager-privilege.yml`) | `manager:power`                                                 |
| Ansible on the manager                        | `ansible/pyproject.toml`                                                                            | `ansible/uv.lock`: one release, one Python, every dependency hashed  | `uv run --locked --isolated`                                                                  | A hash that differs stops the run                               |
| Ansible on a worker                           | `ansible-core` in `ansible/ubuntu/policy.json`                                                      | Exact version                                                        | `ansible/ubuntu/tasks/packages.yml`                                                           | `package:ansible-core`                                          |
| The CLI proxy                                 | `cliproxy/compose.yaml`, `image.lock.json`, `requirements.lock`, `launchd/`, `config.template.yaml` | Image digests; hashed Python dependencies                            | `devfleet cliproxy install`, and `fleet-sync` after it                                        | The proxy's audit                                               |
| Agent profiles and T3 providers               | `agents/registry.json`, `agents/t3.json`; each CLI's configuration from `ansible/agents/templates/` | The commit                                                           | `fleet-sync` (agent profiles through `ansible/agents/agents.yml`)                             | Profile receipts; the plan after every apply; `agent:*:session` |
| Worker time service                           | `ansible/ubuntu/tasks/services.yml`, offsets in `clock` in `ansible/ubuntu/policy.json`             | The commit                                                           | `fleet-sync`                                                                                  | `worker:clock`                                                  |
| The manager's playbook and its receipt        | `ansible/macos/manager.yml`                                                                         | The commit                                                           | `fleet-sync`, check mode first, then applied; re-applied at least daily                       | `manager:playbook`                                              |
| The manager's network time                    | `ansible/macos/manager.yml` (an assert)                                                             | The commit                                                           | macOS                                                                                         | `manager:clock`, `worker:clock-offset`                          |
| fleet-watch on a schedule                     | `fleetWatch` in `ansible/macos/policy.json`, `manager.schedule.watchMinutes` in `fleet.json`        | The commit                                                           | `fleet-sync` (`manager.yml`)                                                                  | `manager:watch`                                                 |
| Rotation of the scheduled jobs' logs          | `jobLogs` in `ansible/macos/policy.json`                                                            | The commit                                                           | `ansible/macos/manager-privilege.yml`, once, as an administrator                              | `manager:job-logs`                                              |
| The manager's container watchdog              | `ansible/monitoring/container-watchdog.py`, `containerWatchdog` in `ansible/macos/policy.json`      | The commit                                                           | `fleet-sync` (`hub-darwin.yml`)                                                               | `manager:container-watchdog`                                    |
| Docker Desktop on the manager                 | `docker_desktop_*` under `[vars]` in `mise.toml`                                                    | Version and build                                                    | You                                                                                           | `manager:docker` (warns)                                        |
| CI                                            | `.github/workflows/`                                                                                | Each action at a commit; tools from `mise.lock`                      | GitHub                                                                                        | `features/rules/`                                               |

A value lives in a policy file when something besides the playbook reads it,
so the check and the playbook cannot disagree. A value only a playbook uses
stays in the playbook: the playbook is its declaration.

## Not declared yet

- **A schedule.** Nothing re-applies the fleet on a timer, so a machine drifts
  until someone runs `fleet-sync`. `fleet-sync --schedule enable` writes a
  launchd job from TypeScript and has never worked from the published package.
  It should become a playbook.
- **The rest of a worker's packages.** Only the packages in `policy.json` are
  pinned. The T3 desktop libraries are installed at whatever version the
  machine's own archive holds, and Ubuntu's security updates move everything
  else, pinned packages included: a pin is a minimum
  ([worker contract](worker-contract.md#package-pins-and-security-updates)).
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
  global mise configuration, the T3 server archive and T3 settings. Each is derived
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

## Keeping pins current

A pin that is only moved by hand goes stale and is then moved in a large
batch, the riskiest way to change a fleet. Each pin is moved by a machine,
one pull request at a time, which CI, the fresh workers and the VM test then
judge like any change, unless it says below why a person moves it.

| Pin                                      | Moved by                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Tools in `mise.toml` and `mise.lock`     | Renovate (`mise`), one pull request per tool                                                  |
| JavaScript and Python dependencies       | Renovate, with lock file maintenance                                                          |
| Actions and CI service images            | Renovate, each action at a commit                                                             |
| mise itself                              | The [Pins workflow](../.github/workflows/pins.yml): `bun bootstrap/pins.ts mise`, weekly      |
| T3 Code (nightly)                        | The Pins workflow: `bun bootstrap/pins.ts t3`, weekly, every artifact hashed                  |
| The tunnel image of the monitoring hub   | Renovate, by tag and digest (a custom manager in `renovate.json`)                             |
| Beszel (hub image and agents)            | A person, because the agents' binary digests need the archives unpacked; `pins.ts` cannot yet |
| Docker Desktop on the manager            | A person, because a person installs it and dev-fleet only measures the version                |
| The Ubuntu snapshot and package versions | A person, because a new snapshot moves every package at once and each needs its exact version |

The workflows never name the mise release: they install it through
[`.github/actions/mise`](../.github/actions/mise/action.yml), which reads
`min_version` from `mise.toml`.

## Changing a pin

| To change               | Edit                                                                 | Then                                  |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| A tool                  | Its version in `mise.toml`                                           | Update `mise.lock` with `mise lock`   |
| mise                    | `bun bootstrap/pins.ts mise` moves `min_version` and the digests     | The fresh-box run                     |
| An Ubuntu package       | `packages` in `ansible/ubuntu/policy.json`, and `snapshot` if needed | The VM test in `ansible/ubuntu/tests` |
| Ansible on the manager  | `ansible/pyproject.toml`                                             | `uv lock` in `ansible/`               |
| Beszel                  | `ansible/monitoring/lock.json`, `compose.yml`, the agent unit        | `bun test features/rules`             |
| A manager power setting | `pmset` in `ansible/macos/policy.json`                               | The next `fleet-sync` applies it      |
