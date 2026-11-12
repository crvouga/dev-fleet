# Runbooks

One entry for every failure code dev-fleet reports: in a check's summary, a
bootstrap phase or an Ansible assertion. Each family says what its codes
mean, how to confirm one, the fix (a command or a `fleet-sync` that applies
the playbook that owns it) and when to escalate. A code whose fix needs a
person (a login, an approval, a choice) is marked **needs a person**.
`features/rules/runbooks.feature` fails when a code in the source has no
entry here, or a `devfleet` command quoted in the documents does not exist.

There are 234 codes; 31 need a person.

## Bootstrap of a new or returning worker

- **Meaning:** The remote bootstrap (`bootstrap/fleet-remote-bootstrap.sh`) stopped before node convergence. It reports the phase and the code, never its output.
- **Confirm:** Run `devfleet fleet-sync --dry-run` and read the `bootstrap:*` check of the worker; `ssh WORKER` and look under `~/.local/share/personal/fleet`.
- **Fix:** Follow the remedy the check prints, then run `devfleet fleet-sync`. The bootstrap resumes where it stopped.
- **Escalate:** A platform or architecture code means the machine must be reinstalled: Ubuntu 26.04 on x86_64 or aarch64.

- `BOOTSTRAP_CAPACITY_UNVERIFIED`: bootstrap capacity unverified.
- `BOOTSTRAP_DISK_CAPACITY_REQUIRED`: bootstrap disk capacity required.
- `BOOTSTRAP_LOCK_TOOL_REQUIRED`: bootstrap lock tool required.
- `CONFIGURATION_INSTALL_FAILED`: configuration install failed.
- `FLEET_APPROVED_BOOTSTRAP_UNAVAILABLE`: fleet approved bootstrap unavailable.
- `FLEET_STATE_PATH_UNSAFE`: fleet state path unsafe.
- `MACOS_ARCHITECTURE_UNSUPPORTED`: macos architecture unsupported. **Needs a person.**
- `MACOS_BASELINE_MISMATCH`: macos baseline mismatch. **Needs a person.**
- `PLATFORM_UNSUPPORTED`: platform unsupported. **Needs a person.**
- `REMOTE_BOOTSTRAP_EVIDENCE_INVALID`: remote bootstrap evidence invalid.
- `REMOTE_BOOTSTRAP_EXIT_FAILED`: remote bootstrap exit failed.
- `ROOT_DEVELOPMENT_USER_REJECTED`: root development user rejected.
- `UBUNTU_ARCHITECTURE_UNSUPPORTED`: ubuntu architecture unsupported. **Needs a person.**
- `XCODE_COMMAND_LINE_TOOLS_REQUIRED`: xcode command line tools required. **Needs a person.**

## Ubuntu packages

- **Meaning:** A package transaction could not run or the package database is inconsistent.
- **Confirm:** `ssh WORKER sudo dpkg --audit` and `sudo apt-get -o Debug::NoLocking=1 check`.
- **Fix:** Let any running package process finish (it is never killed), free disk under `/var`, then run `devfleet fleet-sync`.
- **Escalate:** APT_STATE_BROKEN and DPKG_INTERRUPTED need `sudo dpkg --configure -a` by a person once no package process runs.

- `APT_DISK_FULL`: apt disk full.
- `APT_DNS_UNAVAILABLE`: apt dns unavailable.
- `APT_LOCK_CONTENDED`: apt lock contended.
- `APT_REPOSITORY_UNAVAILABLE`: apt repository unavailable.
- `APT_STATE_BROKEN`: apt state broken. **Needs a person.**
- `DPKG_INTERRUPTED`: dpkg interrupted. **Needs a person.**

## The fleet-owned checkout

- **Meaning:** The checkout of the revision on the machine holds changes fleet-sync did not make, or its bundle changed in transit.
- **Confirm:** `ssh WORKER git -C ~/.local/share/personal/fleet/revisions/REVISION status`.
- **Fix:** Remove that revisions directory and run `devfleet fleet-sync`; it is a cache.
- **Escalate:** A digest mismatch that repeats points at the SSH route.

- `SOURCE_CACHE_CHANGED`: source cache changed.
- `SOURCE_CHECKOUT_CONFLICT`: source checkout conflict.
- `SOURCE_DIGEST_MISMATCH`: source digest mismatch.
- `SOURCE_STATUS_FAILED`: source status failed.

## The pinned toolchain

- **Meaning:** mise, the pinned tools, the global mise configuration or the frozen dependencies did not converge.
- **Confirm:** Run `bun bootstrap/doctor.ts --json --worker` in the checkout on the machine, or read the `tool:*` checks of `devfleet fleet-status`.
- **Fix:** Run `devfleet fleet-sync`; it resumes. TOOLCHAIN_CONFIG_CONFLICT means another tool owns `~/.config/mise/config.toml`: move it away.
- **Escalate:** A tool that fails to download from its pinned artifact needs a new pin in `mise.toml` and `mise.lock` (an issue).

- `LAUNCHER_INSTALLATION_FAILED`: launcher installation failed.
- `TOOLCHAIN_AWS_FAILED`: toolchain aws failed.
- `TOOLCHAIN_CONFIG_CONFLICT`: toolchain config conflict.
- `TOOLCHAIN_CONVERGENCE_FAILED`: toolchain convergence failed.
- `TOOLCHAIN_FROZEN_DEPENDENCIES_FAILED`: toolchain frozen dependencies failed.
- `TOOLCHAIN_MISE_FAILED`: toolchain mise failed.
- `TOOLCHAIN_PATH_CONFIGURATION_FAILED`: toolchain path configuration failed.
- `TOOLCHAIN_T3_FAILED`: toolchain t3 failed.

## The Ubuntu baseline and its services

- **Meaning:** The Ansible baseline (`ansible/ubuntu/baseline.yml`) did not apply, or what it declares is not what the machine runs.
- **Confirm:** Read the `worker:*` and `ubuntu:*` checks of `devfleet fleet-status --workers`; on the worker, `systemctl status SERVICE`.
- **Fix:** Run `devfleet fleet-sync`, which applies the baseline in full when its effect no longer verifies.
- **Escalate:** Ownership conflicts (sudoers, SSH, Docker from another distribution) need a person to migrate the other owner first.

- `DISK_FREE_BELOW_FLOOR`: disk free below floor.
- `DISK_FREE_UNREADABLE`: disk free unreadable.
- `DOCKER_OWNER_CONFLICT`: docker owner conflict. **Needs a person.**
- `MEMORY_RESERVE_MISSING`: memory reserve missing.
- `RESOURCE_CAPACITY_REQUIRED`: resource capacity required.
- `RESOURCE_GUARD_INACTIVE`: resource guard inactive.
- `SERVICE_NOT_ENABLED`: service not enabled.
- `SERVICE_NOT_INSTALLED`: service not installed.
- `SERVICE_NOT_RUNNING`: service not running.
- `SERVICE_RESTART_POLICY`: service restart policy.
- `SSH_UNMANAGED_CONFIG_CONFLICT`: ssh unmanaged config conflict.
- `SUDOERS_OWNERSHIP_CONFLICT`: sudoers ownership conflict. **Needs a person.**
- `SUDO_AUTHORIZATION_REQUIRED`: sudo authorization required. **Needs a person.**
- `SWAP_CAPACITY_REQUIRED`: swap capacity required.
- `SWAP_MISSING`: swap missing.
- `TMP_QUOTA_EXHAUSTED`: tmp quota exhausted.
- `UBUNTU_BASELINE_INCOMPLETE`: ubuntu baseline incomplete.
- `UBUNTU_BASELINE_MISMATCH`: ubuntu baseline mismatch. **Needs a person.**
- `UBUNTU_LINGER_REQUIRED`: ubuntu linger required.
- `UBUNTU_MAINTENANCE_REBOOT_PENDING`: ubuntu maintenance reboot pending.
- `UBUNTU_SESSION_POLICY_PENDING`: ubuntu session policy pending.
- `UBUNTU_SLEEP_POLICY_DRIFT`: ubuntu sleep policy drift.
- `WORKER_RECOVERY_SCRIPT_MISSING`: worker recovery script missing.
- `WORKER_RECOVERY_SETUP_FAILED`: worker recovery setup failed.
- `WORKER_RECOVERY_TIMER_INACTIVE`: worker recovery timer inactive.

## Containers on a worker

- **Meaning:** `worker:docker-run` could not start the pinned container or build a one-line image as the worker user.
- **Confirm:** On the worker, as that user: `docker run --rm --network none --pull never IMAGE true`, with IMAGE from `dockerSmokeTest` in `ansible/ubuntu/policy.json`.
- **Fix:** Run `devfleet fleet-sync`: it starts the engine, adds the user to the docker group and caches the image. A session started earlier keeps its old groups: restart it.
- **Escalate:** A cgroup or runtime failure that survives a reboot is an issue.

- `DOCKER_BUILD_FAILED`: docker build failed.
- `DOCKER_DAEMON_UNREACHABLE`: docker daemon unreachable.
- `DOCKER_DISK_FULL`: docker disk full.
- `DOCKER_RUN_FAILED`: docker run failed.
- `DOCKER_RUN_TIMEOUT`: docker run timeout.
- `DOCKER_SMOKE_IMAGE_MISSING`: docker smoke image missing.
- `DOCKER_SOCKET_ACCESS_DENIED`: docker socket access denied.

## Headless browser on a worker

- **Meaning:** `worker:browser` could not launch the pinned headless Chromium of the web tool profile.
- **Confirm:** On the worker run the headless shell under `/opt/personal-fleet/browser/` with `--headless --no-sandbox --dump-dom about:blank`.
- **Fix:** Run `devfleet fleet-sync`, which installs the pinned libraries and build (`ansible/ubuntu/tasks/browser.yml`).
- **Escalate:** A missing library the policy does not list is an issue: the list needs it.

- `BROWSER_LAUNCH_FAILED`: browser launch failed.
- `BROWSER_LAUNCH_TIMEOUT`: browser launch timeout.
- `BROWSER_LIBRARY_MISSING`: browser library missing.
- `BROWSER_NOT_INSTALLED`: browser not installed.

## Git identity and pushing

- **Meaning:** Commits on the node would carry the wrong author, or git cannot authenticate to GitHub on its own.
- **Confirm:** On the node: `git config --global --get user.name`, and `printf "protocol=https\nhost=github.com\n\n" | GIT_TERMINAL_PROMPT=0 git credential fill >/dev/null`.
- **Fix:** Declare the `git` block in `fleet.json` and run `devfleet fleet-sync` (`ansible/github/git.yml`). Remove lines in `~/.gitconfig` that override it.
- **Escalate:** GIT_REMOTE_REFUSED means the fleet account lost access to the declared repository: a person grants it.

- `GIT_CONFIGURATION_INCOMPLETE`: git configuration incomplete.
- `GIT_CREDENTIAL_HELPER_MISSING`: git credential helper missing.
- `GIT_IDENTITY_MISMATCH`: git identity mismatch.
- `GIT_IDENTITY_MISSING`: git identity missing.
- `GIT_IDENTITY_OVERRIDDEN`: git identity overridden.
- `GIT_IDENTITY_UNDECLARED`: git identity undeclared.
- `GIT_REMOTE_REFUSED`: git remote refused. **Needs a person.**
- `GIT_REMOTE_UNREACHABLE`: git remote unreachable.

## Tailscale

- **Meaning:** A machine is not on the tailnet as the fleet declares it.
- **Confirm:** `tailscale status` on the machine and `devfleet fleet-discover`.
- **Fix:** Sign the machine in (`sudo tailscale up` on a worker, the app on the manager), then run `devfleet fleet-sync`.
- **Escalate:** Logins and device approvals need a person.

- `TAILSCALE_DEVICE_REPLACED`: tailscale device replaced. **Needs a person.**
- `TAILSCALE_ENROLLMENT_REQUIRED`: tailscale enrollment required. **Needs a person.**
- `TAILSCALE_IDENTITY_CONFLICT`: tailscale identity conflict. **Needs a person.**
- `TAILSCALE_INTERACTIVE_AUTHORIZATION_REQUIRED`: tailscale interactive authorization required. **Needs a person.**
- `TAILSCALE_LOGIN_REQUIRED`: tailscale login required. **Needs a person.**
- `TAILSCALE_NODE_MISSING`: tailscale node missing.
- `TAILSCALE_NODE_OFFLINE`: tailscale node offline.
- `TAILSCALE_SETUP_OR_LOGIN_REQUIRED`: tailscale setup or login required. **Needs a person.**
- `TAILSCALE_SOURCE_OWNER_CONFLICT`: tailscale source owner conflict. **Needs a person.**
- `TAILSCALE_UPGRADE_PENDING`: tailscale upgrade pending. **Needs a person.**

## T3 Code

- **Meaning:** The native T3 server or desktop app, its policy, its private route or its providers did not converge or verify.
- **Confirm:** `devfleet t3-status` and the `t3:*` checks of `devfleet fleet-status`.
- **Fix:** Run `devfleet fleet-sync`, then `devfleet t3-apply` for providers. A MIGRATION or MAINTENANCE code names a one-time step in its remedy.
- **Escalate:** Pairing and relinking a peer needs a person in T3 Settings.

- `MANAGER_T3_LINK_UNVERIFIED`: manager t3 link unverified.
- `T3_BASELINE_PREREQUISITES_REQUIRED`: t3 baseline prerequisites required.
- `T3_CACHE_DRIFT`: t3 cache drift.
- `T3_CHECKSUM_MISMATCH`: t3 checksum mismatch.
- `T3_DESKTOP_INSTALL_FAILED`: t3 desktop install failed.
- `T3_DESKTOP_STOPPED`: t3 desktop stopped.
- `T3_DOWNLOAD_UNAVAILABLE`: t3 download unavailable.
- `T3_ENVIRONMENT_IDENTITY_CHANGED`: t3 environment identity changed.
- `T3_EXECUTABLE_FAILED`: t3 executable failed.
- `T3_EXECUTABLE_OWNER_CONFLICT`: t3 executable owner conflict. **Needs a person.**
- `T3_EXTRACTION_FAILED`: t3 extraction failed.
- `T3_INSTALLATION_DRIFT`: t3 installation drift.
- `T3_MANAGER_ENDPOINT_REJECTED`: t3 manager endpoint rejected.
- `T3_MANAGER_ENDPOINT_UNREACHABLE`: t3 manager endpoint unreachable.
- `T3_MANAGER_IDENTITY_UNVERIFIED`: t3 manager identity unverified.
- `T3_MANAGER_ORIGIN_UNRESTRICTED`: t3 manager origin unrestricted.
- `T3_MANAGER_ORIGIN_UNVERIFIED`: t3 manager origin unverified.
- `T3_MODELS_MISMATCH`: t3 models mismatch.
- `T3_MODELS_UNVERIFIED`: t3 models unverified.
- `T3_POLICY_OWNER_CONFLICT`: t3 policy owner conflict. **Needs a person.**
- `T3_POLICY_RESTART_FAILED`: t3 policy restart failed.
- `T3_POLICY_RESTART_PENDING`: t3 policy restart pending.
- `T3_POLICY_STAGE_FAILED`: t3 policy stage failed.
- `T3_PRIVATE_IDENTITY_REQUIRED`: t3 private identity required.
- `T3_PRIVATE_ROUTE_CONFLICT`: t3 private route conflict.
- `T3_PRIVATE_ROUTE_REQUIRED`: t3 private route required.
- `T3_PRIVATE_ROUTE_UNVERIFIED`: t3 private route unverified.
- `T3_PROFILE_CONFLICT`: t3 profile conflict.
- `T3_PROFILE_PENDING`: t3 profile pending.
- `T3_PROFILE_RECORD_INVALID`: t3 profile record invalid.
- `T3_PROFILE_UNVERIFIED`: t3 profile unverified.
- `T3_PROVIDERS_PENDING`: t3 providers pending.
- `T3_PROVIDERS_UNVERIFIED`: t3 providers unverified.
- `T3_PROVIDER_CONFLICT`: t3 provider conflict.
- `T3_PROVIDER_NAMES_PENDING`: t3 provider names pending.
- `T3_PROVIDER_NAMES_UNVERIFIED`: t3 provider names unverified.
- `T3_RESTART_PENDING`: t3 restart pending.
- `T3_SETTINGS_BUSY`: t3 settings busy.

## Monitoring (Beszel)

- **Meaning:** The hub on the manager, an agent on a machine, an enrollment or the hub backups do not match what the fleet declares.
- **Confirm:** The `beszel:*` checks of `devfleet fleet-status --workers`; on the manager `docker compose ls` and the hub at `/_/`.
- **Fix:** Run `devfleet fleet-sync`, which converges the hub, its accounts, its backups and every agent. Hub data is never deleted.
- **Escalate:** BESZEL_HUB_UPGRADE_PENDING needs a verified backup and a planned upgrade by a person.

- `BESZEL_ACCOUNT_INVALID`: beszel account invalid.
- `BESZEL_ACCOUNT_REQUIRED`: beszel account required. **Needs a person.**
- `BESZEL_AGENT_CONNECTION_PENDING`: beszel agent connection pending.
- `BESZEL_AGENT_DISCONNECTED`: beszel agent disconnected.
- `BESZEL_AGENT_KEY_REJECTED`: beszel agent key rejected.
- `BESZEL_AGENT_LOG_UNAVAILABLE`: beszel agent log unavailable.
- `BESZEL_AGENT_TOKEN_REJECTED`: beszel agent token rejected.
- `BESZEL_API_UNAVAILABLE`: beszel api unavailable.
- `BESZEL_API_UNVERIFIED`: beszel api unverified.
- `BESZEL_AUTH_REQUIRED`: beszel auth required.
- `BESZEL_BACKUP_CONVERGENCE_FAILED`: beszel backup convergence failed.
- `BESZEL_BACKUP_NOT_CONVERGED`: beszel backup not converged.
- `BESZEL_BACKUP_OFFHOST_REQUIRED`: beszel backup offhost required.
- `BESZEL_BACKUP_STALE`: beszel backup stale.
- `BESZEL_BACKUP_UNSCHEDULED`: beszel backup unscheduled.
- `BESZEL_BACKUP_UNVERIFIED`: beszel backup unverified.
- `BESZEL_CREDENTIALS_REQUIRED`: beszel credentials required. **Needs a person.**
- `BESZEL_DISK_FULL`: beszel disk full.
- `BESZEL_DISK_UNVERIFIED`: beszel disk unverified.
- `BESZEL_DOCKER_DESKTOP_REQUIRED`: beszel docker desktop required.
- `BESZEL_ENROLLMENT_INCOMPLETE`: beszel enrollment incomplete.
- `BESZEL_HOST_CONFLICT`: beszel host conflict.
- `BESZEL_HUB_INSTALLATION_INCOMPLETE`: beszel hub installation incomplete.
- `BESZEL_HUB_MISMATCH`: beszel hub mismatch.
- `BESZEL_HUB_SELECTION_REQUIRED`: beszel hub selection required.
- `BESZEL_HUB_UNHEALTHY`: beszel hub unhealthy.
- `BESZEL_HUB_UNREACHABLE`: beszel hub unreachable.
- `BESZEL_HUB_UPGRADE_PENDING`: beszel hub upgrade pending. **Needs a person.**
- `BESZEL_INPUT_INVALID`: beszel input invalid.
- `BESZEL_INPUT_LIMIT`: beszel input limit.
- `BESZEL_INSTALLATION_INCOMPLETE`: beszel installation incomplete.
- `BESZEL_LEGACY_DAEMON`: beszel legacy daemon.
- `BESZEL_METRICS_STALE`: beszel metrics stale.
- `BESZEL_NODE_INVALID`: beszel node invalid.
- `BESZEL_NODE_MISSING`: beszel node missing.
- `BESZEL_NODE_TAILNET_REQUIRED`: beszel node tailnet required.
- `BESZEL_NOT_ENROLLED`: beszel not enrolled.
- `BESZEL_NOT_HUB`: beszel not hub.
- `BESZEL_NOT_MANAGER`: beszel not manager.
- `BESZEL_OPERATION_INCOMPLETE`: beszel operation incomplete.
- `BESZEL_PRIVATE_ROUTE_CONFLICT`: beszel private route conflict.
- `BESZEL_PRIVATE_ROUTE_REQUIRED`: beszel private route required.
- `BESZEL_PRIVATE_ROUTE_UNVERIFIED`: beszel private route unverified.
- `BESZEL_PROTOCOL`: beszel protocol.
- `BESZEL_PUBLIC_ENDPOINT_OFFLINE`: beszel public endpoint offline.
- `BESZEL_REMOTE_EVIDENCE_INVALID`: beszel remote evidence invalid.
- `BESZEL_RESPONSE_LIMIT`: beszel response limit.
- `BESZEL_SERVICE_STOPPED`: beszel service stopped.
- `BESZEL_SOURCE_MISMATCH`: beszel source mismatch.
- `BESZEL_TAILSCALE_REQUIRED`: beszel tailscale required.
- `BESZEL_TOKEN_INVALID`: beszel token invalid.
- `BESZEL_TUNNEL_CREDENTIAL_UNAVAILABLE`: beszel tunnel credential unavailable. **Needs a person.**
- `BESZEL_VERSION_MISMATCH`: beszel version mismatch.
- `BESZEL_VIEWER_ROLE`: beszel viewer role.
- `BESZEL_VIEWER_UNPROVISIONED`: beszel viewer unprovisioned.
- `BESZEL_VIEWER_UNVERIFIED`: beszel viewer unverified.

## Coding agents and providers

- **Meaning:** An agent CLI, its profile or a provider behind the CLI proxy did not answer as expected.
- **Confirm:** The `agent:*` and `provider:*` checks of `devfleet fleet-status`, and `devfleet cliproxy` on the manager.
- **Fix:** Run `devfleet fleet-sync`; a rate limit or upstream outage clears on its own.
- **Escalate:** PROVIDER_AUTH_REJECTED needs a person to sign the account in again on the proxy.

- `AGENT_MEMORY_LIMIT_MISSING`: agent memory limit missing.
- `AGENT_MODEL_UNSERVED`: agent model unserved.
- `AGENT_PROFILE_STALE`: agent profile stale.
- `AGENT_SERVICE_ENVIRONMENT_INCOMPLETE`: agent service environment incomplete.
- `AGENT_SERVICE_ENVIRONMENT_UNVERIFIED`: agent service environment unverified.
- `AGENT_SESSION_UNVERIFIED`: agent session unverified.
- `AGENT_VAULT_UNAVAILABLE`: agent vault unavailable.
- `AGENT_VERSION_MISMATCH`: agent version mismatch.
- `PROVIDER_AUTH_REJECTED`: provider auth rejected. **Needs a person.**
- `PROVIDER_EMPTY_RESPONSE`: provider empty response.
- `PROVIDER_MODEL_UNAVAILABLE`: provider model unavailable.
- `PROVIDER_NETWORK_UNVERIFIED`: provider network unverified.
- `PROVIDER_OUTPUT_UNVERIFIED`: provider output unverified.
- `PROVIDER_PROTOCOL_REJECTED`: provider protocol rejected.
- `PROVIDER_RATE_LIMITED`: provider rate limited.
- `PROVIDER_RESPONSE_INVALID`: provider response invalid.
- `PROVIDER_RESPONSE_LIMIT`: provider response limit.
- `PROVIDER_ROUTE_UNVERIFIED`: provider route unverified.
- `PROVIDER_STREAM_INCOMPLETE`: provider stream incomplete.
- `PROVIDER_TIMEOUT`: provider timeout.
- `PROVIDER_TOOL_ARGUMENTS_INVALID`: provider tool arguments invalid.
- `PROVIDER_TOOL_INVALID`: provider tool invalid.
- `PROVIDER_TOOL_MISSING`: provider tool missing.
- `PROVIDER_TOOL_RESULT_UNVERIFIED`: provider tool result unverified.
- `PROVIDER_UNATTENDED_CREDENTIAL_REQUIRED`: provider unattended credential required.
- `PROVIDER_UPSTREAM_UNAVAILABLE`: provider upstream unavailable.
- `PROXY_RECONCILE_UNVERIFIED`: proxy reconcile unverified.
- `UNATTENDED_PROXY_AUTHENTICATION_REQUIRED`: unattended proxy authentication required.

## Provider accounts

- **Meaning:** A change to a provider account on the CLI proxy (sign-in, removal, cooldown) did not complete.
- **Confirm:** `devfleet fleet-accounts` lists every account and its state; `devfleet fleet-accounts --diff` compares this machine.
- **Fix:** Retry the change with `devfleet fleet-accounts`; see [Provider accounts](accounts.md).
- **Escalate:** Signing an account in again needs a person.

- `ACCOUNT_CHANGE_FAILED`: account change failed.

## Vault and credentials

- **Meaning:** A machine cannot read the secrets it needs with its own Vault session.
- **Confirm:** `vault token lookup` on the machine and the `worker:vault-renewal` check.
- **Fix:** Log the machine in once (`devfleet fleet-sync` asks on the manager); renewal is automatic afterwards.
- **Escalate:** A refused policy needs the Vault administrator.

- `UNATTENDED_VAULT_IDENTITY_REQUIRED`: unattended vault identity required.
- `VAULT_LOGIN_REQUIRED`: vault login required. **Needs a person.**
- `VAULT_POLICY_PERMISSION_REQUIRED`: vault policy permission required. **Needs a person.**
- `VAULT_RENEWAL_FAILING`: vault renewal failing.

## Fleet operations and the fleet state

- **Meaning:** fleet-sync could not plan, lock, reach a machine, promote a revision or keep the fleet state.
- **Confirm:** `devfleet fleet-state` for the state, `devfleet fleet-status` for machines, and the report `devfleet fleet-sync` writes.
- **Fix:** Follow the remedy; most clear by running `devfleet fleet-sync` again once the holder of a lock finishes.
- **Escalate:** FLEET_STATE_DIVERGED needs a person to choose which copy of the state to keep (docs/state.md).

- `ANSIBLE_VARIABLE_LIMIT`: ansible variable limit.
- `FLEET_CONNECTION_REQUIRED`: fleet connection required.
- `FLEET_MANAGER_ENROLLMENT_REQUIRED`: fleet manager enrollment required. **Needs a person.**
- `FLEET_MANAGER_LOCKED`: fleet manager locked.
- `FLEET_MANAGER_UNREACHABLE`: fleet manager unreachable.
- `FLEET_NOT_MANAGER`: fleet not manager.
- `FLEET_PLAN_STALE`: fleet plan stale.
- `FLEET_PROMOTION_BLOCKED`: fleet promotion blocked.
- `FLEET_REMOTE_LOCKED`: fleet remote locked.
- `FLEET_REMOTE_OPERATION_FAILED`: fleet remote operation failed.
- `FLEET_REVISION_REQUIRED`: fleet revision required.
- `FLEET_SCHEDULE_PREVIEW`: fleet schedule preview.
- `FLEET_SOURCE_UNAVAILABLE`: fleet source unavailable.
- `FLEET_STATE_DIVERGED`: fleet state diverged. **Needs a person.**
- `FLEET_VERIFICATION_MISSING`: fleet verification missing.
- `MANAGER_AGENT_PROFILES_FAILED`: manager agent profiles failed.
- `MANAGER_DOCKER_DESKTOP_DRIFT`: manager docker desktop drift.
- `MANAGER_DOCKER_DESKTOP_UNOBSERVED`: manager docker desktop unobserved.
- `MANAGER_SLEEPS_ON_POWER`: manager sleeps on power.
- `REMOTE_CONFIGURATION_INCOMPLETE`: remote configuration incomplete.
- `REMOTE_PHASE_FAILED`: remote phase failed.
