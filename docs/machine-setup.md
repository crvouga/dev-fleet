> This document was written for the fleet dev-fleet was extracted from. Paths and
> commands were updated; some statements still describe that fleet and are being
> revised. The README is authoritative.

## Machine setup: macOS, Windows and Linux

This is the shared development setup for **crvouga/dev-fleet**. One versioned
manifest, `mise.toml`, owns the developer tools; `mise.lock` and `.mise/locks/`
own resolved artifacts and dependency graphs. Both bootstraps apply that same
manifest to the current user globally. Other projects can override versions with
their own mise configuration. No paid account or cloud secrets are needed to
install the toolchain.

### New machine

A manager or a worker is set up by `fleet-sync`, run from the published
package ([README](../README.md#quickstart)): it checks out the revision on the
machine and runs `bootstrap/bootstrap.sh` from that checkout. Nothing is
downloaded and run by hand.

To develop dev-fleet, run `bash bootstrap/bootstrap.sh` from a checkout. The
script only ever installs the toolchain of the checkout it is in.

Native Windows, in x64 PowerShell (5.1 or newer):

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/crvouga/dev-fleet/main/bootstrap/bootstrap.ps1 -OutFile "$env:TEMP\workspace-bootstrap.ps1"
& "$env:TEMP\workspace-bootstrap.ps1"
```

If script execution is blocked, use a process-scoped policy for this reviewed
script: `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\workspace-bootstrap.ps1"`.
Do not change the machine-wide execution policy. WSL is optional: run the Linux
bootstrap **inside WSL**, from a checkout there, to install Linux tools; the
native Windows and WSL tool installations, Docker connections and credentials
are separate.

On Windows the default checkout is `~\workspace`; override it with
`-WorkspaceDir C:\path\workspace`. An existing checkout is reused, never reset
or implicitly pulled. From a checkout, run `& ./bootstrap/bootstrap.ps1`.

The scripts install checksum-verified mise **2026.10.24**, trust this repository's
configuration, install pinned Bun, install the shared tools with `--locked`, copy
the managed global config/lock/sidecars, set up persistent shims on PATH, and run
`bun install --frozen-lockfile`. The published global config also trusts the
agent worktree roots in `AGENT_WORKTREE_ROOTS` (`bootstrap/global-config.ts`,
currently `~/.t3/worktrees`): each agent task gets a new checkout, and an
untrusted `mise.toml` there makes every mise shim, `claude` and `bun` included,
exit before the agent starts. Entries added locally with
`mise settings add trusted_config_paths PATH` are kept on every publish.
Reopen your terminal/editor afterward. To refresh
an already-open Unix terminal immediately, run `exec "$SHELL" -l`; an installer
cannot change its parent shell's environment. **If `bun` or `mise` is missing,
run `bash bootstrap/bootstrap.sh` from this checkout first, not a Bun command.**
Unix PATH blocks cover `.profile`, existing `.bash_profile`/`.bash_login`,
`.bashrc`, `.zshenv`, `.zshrc` and fish's config. Zsh uses `ZDOTDIR` when set.
POSIX blocks are quiet, idempotent
and placed before interactive-only early returns, so noninteractive SSH/agent
commands can find the same shims without loading an interactive UI;
Windows updates only the user's PATH; AWS CLI v2 additionally uses the official
versioned MSI (a UAC prompt may appear) because mise's AWS recipe supports only
macOS/Linux. Its version comes from the same manifest and its Windows SHA-256 is
pinned in `vars.aws_windows_msi_sha256`; no unversioned installer is executed.
CI/non-interactive setup never opens an elevation prompt and requires an
administrator context if that MSI needs installation. Existing unrelated mise config/lockfiles
are refused: back them up and move them first, then merge intentional overrides
using project configs. `MISE_CONFIG_DIR` and `XDG_CONFIG_HOME` are respected for
configuration; the PATH step also respects `MISE_DATA_DIR`, `XDG_DATA_HOME` and
`MISE_SHIMS_DIR`, including Windows' `%LOCALAPPDATA%` default.

Fleet's remote bootstrap invokes this same owner with a private `--status-file`
path. The JSON record contains only a version, installer phase and status, never
commands or raw errors. It is diagnostic progress, not proof of fleet readiness.
The native T3 archive verifier checks actual content, modes, links and ownership
by the development user; archive-builder numeric user/group IDs are not portable.
A mismatch leaves the running service and application state untouched.

### OS prerequisites and supported platforms

- **macOS x64 / Apple Silicon:** install Apple's Command Line Tools. If Git is
  absent, bootstrap launches `xcode-select --install`, stops, and asks you to rerun
  after installation. These tools provide Git and native compilers. `curl`, `tar`
  and `unzip` must be available.
- **Linux x64 / arm64, glibc:** Git, curl, trusted CA certificates, tar, unzip, xz
  and a C/C++ compiler/make. If Git is absent, bootstrap installs prerequisites
  with `sudo apt-get` or `sudo dnf`; other distributions receive an actionable
  error. On Debian/Ubuntu with Git already installed, use
  `sudo apt-get install git curl ca-certificates tar unzip xz-utils build-essential`.
  Alpine/musl is not in this baseline.
- **Native Windows x64:** Git for Windows (includes OpenSSH and Git Bash).
  Bootstrap installs it through WinGet if missing; without WinGet, install Git
  from https://git-scm.com/download/win. Windows ARM64 is not yet validated.
  For packages with native C/C++ addons, install Visual Studio Build Tools with
  the Desktop development with C++ workload and Windows SDK. Enable Developer
  Mode if using workstation symlink features; core toolchain setup uses copies
  and does not require symlinks or an administrator shell.

Git, OS compilers/SDKs, Docker Engine/Desktop, desktop apps, and kernel versions
are **OS prerequisites**, not covered by the mise lock. The same tool versions
are selected across OSes, using different platform binaries; this does not make
all OS behavior or every project command identical. Existing infrastructure
scripts may require Bash/Unix tooling; use Git Bash where supported or WSL for
Linux-specific workflows. Exact container builds should pin base image digests.

### Included toolchain

The generated guide includes the exact tool table from `mise.toml` below. Scope:

- **Source control:** OS Git/OpenSSH, pinned GitHub CLI and Git LFS.
- **JavaScript/TypeScript:** Node **with npm**, Bun, pnpm, Yarn and Deno.
  TypeScript, ESLint, Prettier, Turbo and test frameworks remain project
  dependencies installed from `bun.lock`; do not install duplicate global copies.
- **Languages/builds:** Python (precompiled), uv/uvx, Go, Rust/Cargo/rustfmt/Clippy,
  CMake, Ninja and Just. OS compilers/linkers remain prerequisites: Apple Command
  Line Tools, Linux build-essential/GCC, or Windows MSVC Build Tools + SDK.
  Java (Temurin 25 LTS) and .NET 10 SDK are locked on-demand tools.
  Project manifests still select project-specific language/library versions.
- **CLI utilities:** ripgrep (`rg`), fd, fzf, bat, delta, jq and Mike Farah yq.
- **Delivery/infra:** Vercel, Wrangler, Railway, OpenTofu, Vault CLI (for the OpenBao-compatible secret service), Docker CLI,
  ShellCheck, shfmt, actionlint, AWS CLI v2, kubectl and Helm. Installing provider CLIs does not authorize agents
  to provision resources; shared infrastructure is still OpenTofu-owned.
- **Agent harnesses:** Claude Code (`claude`), Codex (`codex`), Gemini CLI
  (`gemini`), GitHub Copilot CLI (`copilot`) and OpenCode (`opencode`).
  Installed versions are checked by doctor on all three OSes. Start the CLI you
  want to use and complete its interactive sign-in; installation does not copy
  tokens, choose paid plans or grant agent permissions. OpenCode's optional
  settings remain managed by `personal` and Vault. Codex sign-in follows the
  [official CLI guide](https://learn.chatgpt.com/docs/codex/cli).
  Claude/Copilot background self-updaters are disabled through mise environment
  settings so they cannot silently replace locked versions; update through this
  repository instead.
- **Security/data/HTTP:** Gitleaks for secret scanning, SOPS + age for encrypted
  files, xh for HTTP requests, and usql for SQL database connections. Installing
  these tools does not create encryption keys or copy credentials.
- **Agent/container development:** Dev Containers CLI (`devcontainer`) is included.
  MCP Inspector is pinned on demand; use it only for the MCP server you intend
  to inspect, and follow the tool's local access instructions.
- **On demand:** Atlas (macOS/Linux), Azure CLI, Google Cloud CLI, AWS CDK/SAM,
  Java/.NET SDKs and MCP Inspector are locked lazy tools. Install one with
  `mise install --locked <tool>`, for example `mise install --locked gcloud`, or
  install the whole catalog with `mise install --locked --include-lazy`.
  AWS SAM is currently macOS/Linux only in mise; native Windows users can use
  AWS's supported SAM installer when their project needs it.
  Lazy tools are excluded from the base doctor's required checks; large SDKs
  may require their documented OS prerequisites and project-specific versions.

**nvm is intentionally replaced by mise's Node version management.** Unix nvm
and nvm-windows are different implementations. Use `mise use node@<version>` in
a project instead of `nvm install/use`; root `.nvmrc` remains a compatibility pin
for existing CI. Remove/disable old nvm, fnm, asdf or Volta shell initialization
if it shadows managed tools. Never silently delete another manager's files.
Do not independently upgrade npm, Corepack shims, or globally npm-install tools
already owned by mise. The npm version comes from the pinned Node release.

### Verify, authenticate and configure

After reopening the shell:

```sh
cd ~/workspace
mise exec -- bun bootstrap/doctor.ts
mise exec -- bun bootstrap/doctor.ts --json
# Require a working container runtime and both plugins:
mise exec -- bun bootstrap/doctor.ts --docker
```

Doctor fails missing/wrong required tool versions and missing Git/npm. Missing
GitHub authentication and Docker runtime/plugins are warnings unless Docker is
explicitly required. `--json` emits structured checks without credential values.
`mise doctor` diagnoses mise itself. Use `where.exe node` / `Get-Command node -All`
on Windows, or `type -a node` on Unix, to find conflicting installations.

Authentication remains per-machine and interactive; never copy tokens into Git:

```sh
gh auth login
gh auth setup-git
gh auth status
vercel login
wrangler login
railway login
```

Only sign into providers the task actually needs. On fleet machines the Git
identity and the GitHub credential helper come from the `git` block of
`fleet.json`: `fleet-sync` writes them in `~/.config/git/config` and checks
them as `worker:git-identity` and `worker:git-push-auth`. With
`"signing": "ssh"` in that block every node also makes an SSH key of its own
(`~/.ssh/dev-fleet-git-signing`, never copied off the node) and signs every
commit and tag with it, checked as `worker:git-signing`; GitHub shows those
commits as verified once you add each node's `.pub` to the account as a
signing key (`gh ssh-key add ~/.ssh/dev-fleet-git-signing.pub --type signing`
on the node). Elsewhere set `git
config --global user.name` and `user.email` after confirming them; do not guess
an email or overwrite an existing identity. Enable Git LFS hooks when needed with `git lfs install`.

Optional existing workstation/agent settings:

```sh
sh bootstrap/install-launcher.sh
devfleet fleet-status --local
# Only for tasks needing the workspace's managed secrets:
vault login --method=userpass username=example-user
devfleet fleet-sync
```

The machine bootstrap installs tools/dependencies only. `personal:install` additionally
installs the existing workstation launcher and converges OpenCode configuration;
it may need platform permissions and a Vault login for credential-backed
features. `bun run setup` remains dependency installation only.

### Working with modern repositories

After bootstrap, clone with `gh repo clone owner/repo`, read that repository's
`AGENTS.md`/README and language manifests, and trust its mise config only after
review. Use its lockfile and declared package manager: `bun install --frozen-lockfile`,
`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`,
`uv sync --locked`, `cargo build --locked` or `go mod download` as appropriate.
Do not install global copies of project-owned TypeScript, ESLint, Prettier, test
frameworks or SDK libraries. For a `.devcontainer` project, use
`devcontainer up --workspace-folder .` after Docker readiness succeeds.

Database servers (PostgreSQL, MySQL, Redis, etc.) and local services belong in
the project's versioned Compose/devcontainer configuration. The shared setup
provides the Docker and SQL clients; it does not start unrequested background
servers or occupy their ports. Python and Bun provide SQLite support without
requiring a separate global database daemon. Mobile/iOS/Android toolchains and
platform-specific native dependencies remain project/OS prerequisites.

Cloud sign-in is per machine: `aws configure sso` / `aws sso login`,
`gcloud auth login` and `az login` only when the task needs that provider.
Use named profiles and existing credentials; never put access keys in this repo.
Kubernetes contexts, cloud resource creation and production deployment still
follow each repository's authorization and IaC rules.

### Containers: CLI versus engine

The manifest installs the **Docker client**. Containers also require a local or
remote Docker engine, Compose v2 and Buildx plugins. These cannot be installed as
one identical unprivileged binary on all OSes.

- **macOS:** run `bash bootstrap/docker-desktop.sh` to install the pinned,
  checksum-verified Docker Desktop bundle from this repository and open it.
  Complete its first-run agreement/setup in the app. Repeated invocation reuses
  an existing installation. The shared mise Docker client remains in use.
  Vendor installation documentation: Docker Desktop from https://docs.docker.com/desktop/setup/install/mac-install/.
- **Windows:** install/start Docker Desktop from https://docs.docker.com/desktop/setup/install/windows-install/.
  `winget install --exact --id Docker.DockerDesktop` is the package-manager route.
  Enable its WSL2 backend/virtualization prerequisites and finish any reboot.
- **Linux:** follow https://docs.docker.com/engine/install/ for the distribution.
  Install Engine plus `docker-buildx-plugin` and `docker-compose-plugin`, then
  start the daemon (usually `sudo systemctl enable --now docker`). Use Docker's
  documented rootless mode when appropriate. Adding a user to the `docker` group
  grants root-equivalent access; do not do so silently in bootstrap.
- **Remote/headless:** select a preconfigured Docker context instead. Do not
  overwrite an existing context or expose an unauthenticated TCP daemon.

Docker Desktop supplies Compose/Buildx. On Linux they must be installed as CLI
plugins. The pinned mise client should discover plugins in standard Docker
locations; if not, check `docker info` and configure Docker's `cliPluginsExtraDirs`
for that installation. Verify with `docker version`, `docker compose version`,
`docker buildx version`, and optionally `docker run --rm hello-world` (downloads
an image). CLI pinning does not pin or upgrade your engine/plugins.

### Lockfile coverage and reviewed package metadata

Most binary tools have platform URLs/checksums in `mise.lock`; npm/Python tools
also have dependency graphs in `.mise/locks/`. Rust is managed by the native
Rustup backend: mise pins the exact release, and Rustup verifies its versioned
component distribution manifests rather than recording component hashes in mise's
lock. AWS Windows uses the reviewed MSI checksum in the same manifest.

MCP Inspector's dependency graph currently selects the manually published Pino
9.14.0 backport, whose npm publisher metadata differs from the newer 10.x trusted
publisher stream. The manifest's single-version trust-policy exception was added
after verifying npm's SHA-512 integrity and all 139 published JavaScript files
against `pinojs/pino`'s `v9.14.0` tag, plus matching package scripts/dependencies.
The frozen graph still verifies its artifact integrity; no global trust checks
are disabled. Remove that narrow exception when the upstream metadata is fixed.

### Keep machines synchronized

From the checkout, on any platform:

```sh
git pull --ff-only
mise install --locked bun
mise exec --locked bun -- bun bootstrap/setup.ts
```

On fleet machines `devfleet fleet-sync` refreshes the toolchain, the global
configuration and frozen dependencies; `mise exec --locked bun -- bun
bootstrap/setup.ts --tools-only` reapplies tool pins and the global
configuration without touching project dependencies, and `bun
bootstrap/doctor.ts --json` verifies them. Sync is explicit; Git commits do not silently update other machines.

For multiple development computers, use [the fleet package](operations.md):
`devfleet fleet-node-add` registers an existing SSH alias in a local roster,
`devfleet fleet-nodes --onboard` generates per-node connection/auth/editor steps,
and `devfleet fleet-status --json` diagnoses SSH, authentication, T3 Connect
settings/API and checkout/lockfile drift. `devfleet fleet-repair --repair workspace`
previews convergence through this same setup script; applying requires
`--apply --yes`. No credentials are copied or cloud resources provisioned;
VS Code/T3 end-to-end tests remain explicit operator steps.

Bootstrap each node once using the same reviewed checkout revision, then check
tool discovery through its actual SSH alias (not just an interactive terminal):

```sh
ssh YOUR_ALIAS 'command -v mise; command -v bun; command -v node; command -v npm'
devfleet fleet-status --json
devfleet fleet-repair --repair workspace
devfleet fleet-repair --repair workspace --apply --yes
```

Review the sync plan before applying. SSH must already work and nodes must be in
your local fleet roster; bootstrap does not create accounts, pair T3, authorize
SSH keys or copy credentials. Remote Bash sessions depend on sshd sourcing
`.bashrc`; shells launched with startup files disabled need an explicit PATH or
the absolute `~/.local/bin/mise exec --locked -- COMMAND` entry point. On Windows,
restart the parent editor/agent process to inherit the updated user PATH.

To change versions: edit pins with `mise use --pin <tool>@<version>` (or edit
`mise.toml`), run `mise lock`, review `mise.toml`, `mise.lock` and any `.mise/locks/`
changes, and test. Keep Bun's pin in `package.json` and the setup action aligned;
keep Node's `.nvmrc` aligned. Run `bun run llms:sync` to regenerate the served
local agent guide, then commit. Do not use `mise upgrade` independently on each machine.
Version policy: use the newest stable compatible releases, with the newest Node
LTS rather than an untested Current release. The current compatibility exceptions
are delta 0.18.2 (newer releases omit Intel macOS), OpenTofu 1.13.0 (all infrastructure
roots and deployment gates require that exact version), and OpenCode 1.19.5
(the workspace's notification/provider plugins still target the 1.x API). Their
major/platform migrations must be validated before moving those pins. Python
and other standalone tools use their latest stable releases at the last update.

Locked downloads still need network access; GitHub limits may require an
authenticated `gh` session. Never disable verification to bypass a failing lock.

### Agent entry point and ownership

This runbook is part of the local development infrastructure guide,
https://www.example.com/llms-local.txt#machine-setup-macos-windows-and-linux.
Cloud app infrastructure (Vault, databases, storage, hosting) is a separate guide.
The root `llms-local.txt` and served `/llms-local.txt` are generated by
`bun run llms:sync` from `scripts/llms-local.template.md`, this file and
`mise.toml`. Never edit generated copies. Read root `AGENTS.md` before
working in the repo. Claude Code, Gemini CLI and Copilot have thin checked-in
instruction files pointing to that same canonical document; Codex/OpenCode use
`AGENTS.md` directly. Harness credentials and personal settings remain per machine. Bootstrap is authorized only when the user requests machine
setup; fetching a public guide alone does not authorize installs or logins.

### Pinned native T3 for Ubuntu fleet services

The shared setup owner verifies the Linux T3 release archive against the
architecture-specific SHA-256 pins in `mise.toml` (`t3_version` and
`t3_linux_*_sha256`). Artifacts live under `~/.local/share/personal/tools/`.
Workstation uses that absolute executable for policy commands. The worker's
only running T3 is the T3 Code desktop app, installed from the same release's
`.deb` (pinned by `t3_desktop_*_sha256`, computed from the release assets since
upstream `SHA256SUMS` omits packages) and started by the `t3code-desktop.service`
user unit in the GDM auto-login session. It shares `~/.t3` with the former
headless service, so environment identity and pairing are kept. A conflicting
launcher version requires reviewed maintenance; the recovery timer stops a
still-running headless service. Routine fleet-sync never ends a running turn
to load a new pin or policy: the app restarts into them at the first idle
check (`t3:running-version`, `t3:policy-loaded`). The disposable Ubuntu VM test still exercises the former headless service
and does not cover the desktop session. Private routing and paired execution
require separate evidence.

Normal Ubuntu fleet setup is controller-led:
`devfleet fleet-sync`. See the
[Fleet runbook](ubuntu-sync.md). A controller without
Node/npm must first run this tracked bootstrap (or install the documented Node
prerequisite); `npx` cannot execute before Node/npm exist. Reachable remote targets
are bootstrapped over verified SSH by the same shared owner.

Repeated approved setup reuses an observed matching mise executable and preserves
unchanged managed configuration/lockfile timestamps. It still asks mise and the
frozen dependency owner to inspect actual installations; a previous success marker
is not a reason to skip drift inspection.

### T3 project actions

Project scripts use `bash bootstrap/project-action.sh ACTION` from the checkout.
Actions are named exactly like the `personal` command they run, so a T3 script
label reads the same as the CLI: `warm`, `portfolio`, `workstation-sync`,
`workstation-update`, `workstation-net-fix`, `workstation-net-check`,
`workstation-net-fix-check`, `fleet-sync`, `fleet-status`, `fleet-repair`, `infra-cliproxy`. Label
each T3 script `Domain: Command words` (`Fleet: Sync`, `Fleet: Status`,
`Workstation: Net check`, `Infra: Cliproxy model health` running `infra-cliproxy model-health`; `infra-cliproxy model-suite --target mock` is the offline, credential-free suite). `fleet-sync` selects the current checkout HEAD as its
exact revision and retains its approval flow; extra arguments such as `--dry-run`
are forwarded. `fleet-status` runs `devfleet fleet-status --workers`, the
canonical worker audit that reports excluded service hosts. Repair previews without applying. Each invocation runs the shared bootstrap first, reusing installed
locked tools and converging dependencies for the current branch. `warm` performs
only that setup. No global `ws` or `personal` launcher is required. Setup may
install tools on first use; application logins (including Vault for portfolio)
remain per-machine prerequisites. Configuration actions affect the current machine.

### Minimal worker profile

Controller-driven remote bootstrap passes `--worker` to the shared setup owner.
It installs the `vars.worker_tools` subset from `mise.toml`, with versions and
artifacts taken from the same `mise.lock`; native T3 and Ubuntu Docker/service
policy remain source-pinned. `bun bootstrap/doctor.ts --worker --docker --json`
checks that profile. It does not require unrelated cloud CLIs on workers.

Tool profiles add locked tool sets on top of it: `worker.toolProfiles` in
`fleet.json` (fleet-wide) or `toolProfiles` on one worker selects `web` (pnpm,
Deno, Yarn and headless Chromium for browser tests), `go`, `rust` (with CMake
and Ninja) or `jvm` (Temurin), each a `worker_profile_<name>` under `[vars]` in
`mise.toml`. `worker.tools` adds single tools dev-fleet already pins. The setup
installs them (`--node` reads the installed configuration) and the doctor
checks each as `tool:<name>` (`--profiles`, `--tools`). The base tools include
`tmux`, for sessions that outlive an SSH connection.

A tool dev-fleet does not ship belongs to the project that needs it: pin it in
the project's own `mise.toml` and lock it with `mise lock`. On every fleet
machine dev-fleet's global configuration sets `locked = true` for the
`project` scope, so mise installs a project's tools in a checkout only from
that project's `mise.lock` and refuses a tool the lock does not name;
`mise install --locked` in the checkout installs and verifies them.

There is no `mobile` profile. No mobile toolchain can be pinned with
checksums for both worker architectures through mise: Flutter publishes no
Linux arm64 release, the Android SDK's platforms and build tools are fetched
by `sdkmanager` at run time (outside any lock, behind a licence a person
accepts), and iOS builds need macOS and Xcode, which workers are not. A
project that builds for Android on x86_64 workers pins `flutter`, `java` and
`android-sdk` in its own `mise.toml` as above.

`worker.exposure` (fleet-wide) or `exposure` on one worker says what a worker
opens beyond loopback and the tailnet; without it, nothing. See
[Exposure](ubuntu-sync.md#exposure).

The source-owned `worker-auth.ts` timer renews the worker's existing Vault token
and can restore the declared GitHub account from its authorized Vault service
credential, without copying another machine's login directory.
