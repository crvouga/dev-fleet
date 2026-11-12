#!/bin/sh
# Executed over strict SSH from the selected verified Git revision. stdin is
# one line holding the base64 fleet configuration (empty when there is none),
# then the base64 Git bundle (nothing in cached mode). All executable content
# remains in this tracked source. The Ubuntu releases workers may run are
# named once, in ansible/ubuntu/policy.json; the manager passes them in.
set -eu
umask 077
revision=$1
bundle_sha=$2
node=$3
source_mode=${4:-transfer}
releases=${5:-}
case "$source_mode" in cached|transfer) ;; *) exit 2;; esac
case "$releases" in *[!0-9.\ ]*|'') exit 2;; esac
case "$revision" in *[!a-f0-9]*|'') exit 2;; esac
[ "${#revision}" = 40 ] || exit 2
case "$bundle_sha" in *[!a-f0-9]*|'') exit 2;; esac
[ "${#bundle_sha}" = 64 ] || exit 2
case "$node" in *[!a-z0-9-]*|'') exit 2;; esac
phase=bootstrap
bundle=''
code=0
apt_log=''
failure_code=REMOTE_BOOTSTRAP_INCOMPLETE
die() { failure_code=$1; exit 1; }
# One remedy per failure: what the operator does next. Never raw output.
remedy() {
  case "$1" in
    FLEET_REMOTE_LOCKED) echo 'Another fleet operation holds this machine. Wait for it to finish; rerun fleet-sync afterwards. Never remove the lock while its holder runs.';;
    ROOT_DEVELOPMENT_USER_REJECTED) echo 'Connect as the non-root developer account the fleet configuration names.';;
    UBUNTU_BASELINE_MISMATCH|UBUNTU_ARCHITECTURE_UNSUPPORTED|PLATFORM_UNSUPPORTED) echo 'Workers run an Ubuntu release docs/support-matrix.md lists, on x86_64 or aarch64. Reinstall the machine; fleet-sync never upgrades an operating system.';;
    WORKER_ENVIRONMENT_UNSUPPORTED) echo 'WSL2 is not a worker. Run the worker on a physical or virtual machine of its own (docs/support-matrix.md).';;
    FLEET_STATE_PATH_UNSAFE) echo 'A fleet state directory under ~/.local/share/personal is a symbolic link. Replace it with a real directory.';;
    BOOTSTRAP_CAPACITY_UNVERIFIED|BOOTSTRAP_DISK_CAPACITY_REQUIRED) echo 'Free at least 2 GiB and 50000 inodes on the home file system, then rerun fleet-sync.';;
    SOURCE_DIGEST_MISMATCH) echo 'The bundle changed in transit. Rerun fleet-sync; if it repeats, check the SSH route.';;
    SUDO_AUTHORIZATION_REQUIRED) echo 'Grant the developer account passwordless sudo, or run fleet-sync interactively once to authorize it.';;
    APT_LOCK_CONTENDED) echo 'Another package operation held the APT lock past the bounded wait. Let it finish (it is never killed), then rerun fleet-sync.';;
    APT_DNS_UNAVAILABLE) echo 'The worker cannot resolve the Ubuntu archive. Restore its DNS, then rerun fleet-sync.';;
    APT_REPOSITORY_UNAVAILABLE) echo 'The Ubuntu archive could not be reached. Check the network or archive status, then rerun fleet-sync.';;
    APT_DISK_FULL) echo 'Package installation ran out of disk space. Free space under /var and /usr, then rerun fleet-sync.';;
    DPKG_INTERRUPTED) echo 'An earlier package installation that fleet-sync did not start was interrupted. Run sudo dpkg --configure -a once no package process is running, then rerun fleet-sync.';;
    APT_UPDATE_FAILED|APT_INSTALL_FAILED) echo 'Run sudo apt-get update and install the bootstrap packages by hand to see the error, then rerun fleet-sync.';;
    SOURCE_CACHE_CHANGED|SOURCE_STATUS_FAILED|SOURCE_CHECKOUT_CONFLICT) echo 'The fleet-owned checkout of this revision holds changes fleet-sync did not make. Inspect and remove that revisions directory, then rerun fleet-sync.';;
    CONFIGURATION_INSTALL_FAILED) echo 'The fleet configuration could not be written under ~/.config/dev-fleet. Check that directory, then rerun fleet-sync.';;
    TOOLCHAIN_*) echo 'The pinned toolchain did not converge. Rerun fleet-sync; it resumes where it stopped. If it repeats, run devfleet fleet-status --node for this worker.';;
    *) echo 'Inspect the remote operation lock and rerun the approved revision. No success receipt advanced.';;
  esac
}
# Names an APT failure by the fixed messages of the pinned Ubuntu release.
apt_failure() {
  if grep -q 'Could not get lock' "$apt_log" 2>/dev/null; then die APT_LOCK_CONTENDED
  elif grep -q 'No space left on device' "$apt_log" 2>/dev/null; then die APT_DISK_FULL
  elif grep -qE 'Temporary failure resolving|Could not resolve' "$apt_log" 2>/dev/null; then die APT_DNS_UNAVAILABLE
  elif grep -qE 'Failed to fetch|Unable to connect|Connection failed|Unable to locate package' "$apt_log" 2>/dev/null; then die APT_REPOSITORY_UNAVAILABLE
  elif grep -q 'dpkg was interrupted' "$apt_log" 2>/dev/null; then die DPKG_INTERRUPTED
  else die "$1"
  fi
}
fail() {
  printf '{"version":1,"checks":[{"id":"bootstrap:%s","status":"fail","summary":"%s","remedy":{"action":"%s"}}]}\n' "$phase" "$failure_code" "$(remedy "$failure_code")"
}
trap 'code=$?; [ -z "$bundle" ] || rm -f -- "$bundle"; [ -z "$apt_log" ] || rm -f -- "$apt_log"; if [ "$code" != 0 ]; then fail; fi' EXIT
# Preserve the lock holder if its SSH channel disappears mid-install.
trap '' HUP
trap 'exit 1' INT TERM
# No shell startup assumptions, and no implicit root development user.
[ "$(id -u)" != 0 ] || die ROOT_DEVELOPMENT_USER_REJECTED
# Workers are the Ubuntu releases the policy accepts (docs/support-matrix.md).
[ "$(uname -s)" = Linux ] || die PLATFORM_UNSUPPORTED
# shellcheck source=/dev/null
. /etc/os-release
[ "$ID" = ubuntu ] || die UBUNTU_BASELINE_MISMATCH
case " $releases " in *" $VERSION_ID "*) ;; *) die UBUNTU_BASELINE_MISMATCH;; esac
case "$(uname -m)" in x86_64|aarch64) ;; *) die UBUNTU_ARCHITECTURE_UNSUPPORTED;; esac
! grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null || die WORKER_ENVIRONMENT_UNSUPPORTED
root="$HOME/.local/share/personal/fleet"
# Refuse symlinked state roots rather than allowing writes through them.
for path in "$HOME/.local" "$HOME/.local/share" "$HOME/.local/share/personal" "$root"; do
  [ ! -L "$path" ] || die FLEET_STATE_PATH_UNSAFE
done
mkdir -p "$root"
phase=lock
[ ! -L "$root/remote-operation.lock" ] || exit 1
exec 9>"$root/remote-operation.lock"
# The lock follows this shell's open descriptor and is released when it exits.
flock -n 9 || die FLEET_REMOTE_LOCKED
# The operation record: a manager that lost its session reads it to follow
# this operation to its end instead of starting another (see
# src/remote-operation.ts). The result of the last operation is beside it.
started=$(date +%s)
result="$root/remote-operation-result.json"
[ ! -L "$root/remote-operation.json" ] && [ ! -L "$result" ] || die FLEET_STATE_PATH_UNSAFE
rm -f -- "$result"
operation() {
  printf '{"version":1,"pid":%s,"revision":"%s","node":"%s","started":%s,"phase":"%s"%s}\n' "$$" "$revision" "$node" "$started" "$1" "${2:-}" >"$root/remote-operation.json.new" &&
    mv -f -- "$root/remote-operation.json.new" "$root/remote-operation.json"
}
operation lock
# The fleet configuration is installed under the lock, so two overlapping
# runs never write it at once. It holds no secret.
phase='configuration-install'
IFS= read -r configuration || configuration=''
if [ -n "$configuration" ]; then
  config_dir="$HOME/.config/dev-fleet"
  mkdir -p "$config_dir" || die CONFIGURATION_INSTALL_FAILED
  printf '%s' "$configuration" | base64 -d >"$config_dir/fleet.json.new" || die CONFIGURATION_INSTALL_FAILED
  mv "$config_dir/fleet.json.new" "$config_dir/fleet.json" || die CONFIGURATION_INSTALL_FAILED
fi
phase=resources
operation resources
# A bootstrap floor protects source transfer and minimal prerequisites. The
# Workstation baseline subsequently enforces its stricter declared capacity.
free_kib=$(df -Pk "$root" | awk 'END {print $4}')
free_inodes=$(df -Pi "$root" | awk 'END {print $4}')
case "$free_kib:$free_inodes" in *[!0-9:]*|:*|*:) die BOOTSTRAP_CAPACITY_UNVERIFIED;; esac
[ "$free_kib" -ge 2097152 ] && [ "$free_inodes" -ge 50000 ] || die BOOTSTRAP_DISK_CAPACITY_REQUIRED
phase=source-transfer
if [ "$source_mode" = transfer ]; then
bundle=$(mktemp "$root/source.XXXXXX")
# Leave no executable payload copies; this temporary file is only Git data.
base64 -d >"$bundle"
printf '%s  %s\n' "$bundle_sha" "$bundle" | sha256sum -c - >/dev/null 2>&1 || die SOURCE_DIGEST_MISMATCH
fi
phase=prerequisites
missing=''
for package in git curl ca-certificates unzip xz-utils build-essential python3 ansible-core; do
  dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -qx installed || missing="$missing $package"
done
if [ -n "$missing" ]; then
  sudo -n true >/dev/null 2>&1 || die SUDO_AUTHORIZATION_REQUIRED
  # APT's own messages, in a private file read only for fixed patterns and
  # removed on exit: they tell a held lock, DNS, an unreachable archive and a
  # full disk apart. Nothing of them is reported.
  apt_log=$(mktemp "$root/apt.XXXXXX")
  pending="$root/prerequisites-pending"
  # An installation this script started and that was interrupted (the shell
  # killed, the machine powered off) leaves dpkg half-configured. Finishing
  # our own transaction is safe; one fleet-sync did not start is reported.
  # dpkg reads its database lock even to audit, which needs root.
  if [ -n "$(sudo -n dpkg --audit 2>/dev/null)" ]; then
    [ -f "$pending" ] || die DPKG_INTERRUPTED
    # shellcheck disable=SC2024
    sudo -n timeout 600 env DEBIAN_FRONTEND=noninteractive LC_ALL=C dpkg --configure -a >"$apt_log" 2>&1 || apt_failure APT_INSTALL_FAILED
  fi
  : >"$pending"
  # The log belongs to the developer account; sudo only runs the command.
  # shellcheck disable=SC2024
  # Never remove APT locks or kill package processes. Timeout keeps genuine
  # transactions bounded; Ubuntu archive signatures/TLS remain enabled.
  sudo -n timeout 300 env LC_ALL=C apt-get -o DPkg::Lock::Timeout=120 update >"$apt_log" 2>&1 || apt_failure APT_UPDATE_FAILED
  # shellcheck disable=SC2086,SC2024
  sudo -n timeout 600 env DEBIAN_FRONTEND=noninteractive LC_ALL=C apt-get -o DPkg::Lock::Timeout=120 --no-install-recommends install -y $missing >>"$apt_log" 2>&1 || apt_failure APT_INSTALL_FAILED
  rm -f -- "$pending" "$apt_log"
  apt_log=''
fi
phase=source-verification
deployment="$root/revisions/$revision"
[ ! -L "$root/revisions" ] && [ ! -L "$deployment" ] || exit 1
mkdir -p "$deployment"
if [ ! -e "$deployment/.git" ]; then
  [ -z "$(ls -A "$deployment")" ] || exit 1
  git -C "$deployment" init -q >/dev/null 2>&1 || exit 1
fi
# An interrupted initial fetch or checkout leaves a repository without a
# commit, possibly with some of the revision's files written. Resume only
# that state: every file present must be a file of the revision, so the
# checkout may write over it. An existing commit or other work is never reset.
if ! git -C "$deployment" rev-parse --verify HEAD >/dev/null 2>&1; then
  [ "$source_mode" = transfer ] || die SOURCE_CACHE_CHANGED
  [ "$(git -C "$deployment" rev-parse --show-toplevel)" = "$deployment" ] || exit 1
  # The bundle holds this commit without its history: declare the checkout
  # shallow at it so Git accepts a commit whose parents are absent.
  printf '%s\n' "$revision" >"$deployment/.git/shallow"
  git -C "$deployment" fetch --no-tags "$bundle" "$revision" >/dev/null 2>&1 || exit 1
  present=$(mktemp "$root/present.XXXXXX")
  expected=$(mktemp "$root/expected.XXXXXX")
  git -C "$deployment" -c core.quotePath=false ls-files --others | LC_ALL=C sort >"$present" || { rm -f -- "$present" "$expected"; die SOURCE_STATUS_FAILED; }
  git -C "$deployment" -c core.quotePath=false ls-tree -r --name-only "$revision" | LC_ALL=C sort >"$expected" || { rm -f -- "$present" "$expected"; die SOURCE_STATUS_FAILED; }
  foreign=$(LC_ALL=C comm -23 "$present" "$expected")
  rm -f -- "$present" "$expected"
  [ -z "$foreign" ] || die SOURCE_CHECKOUT_CONFLICT
  git -C "$deployment" checkout --force --detach "$revision" >/dev/null 2>&1 || exit 1
fi
[ -z "$bundle" ] || rm -f "$bundle"
bundle=''
[ "$(git -C "$deployment" rev-parse HEAD)" = "$revision" ] || exit 1
[ "$(git -C "$deployment" rev-parse --show-toplevel)" = "$deployment" ] || exit 1
clean=$(git -C "$deployment" status --porcelain) || die SOURCE_STATUS_FAILED
[ -z "$clean" ] || die SOURCE_CHECKOUT_CONFLICT
phase=toolchain
operation toolchain
cd "$deployment"
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin"
status_file="$root/toolchain-status.json"
ready_file="$root/toolchain-ready"
[ ! -L "$status_file" ] && [ ! -L "$ready_file" ] || die FLEET_STATE_PATH_UNSAFE
# Warm: the same toolchain inputs (tool pins, locks and the setup code itself)
# passed within a day, so a revision that changes none of them skips the full
# setup. Changed inputs, a failure or an older stamp run it; agent versions
# are still checked (and reinstalled on drift) by node convergence.
toolchain_key=$(git rev-parse HEAD:mise.toml HEAD:mise.lock HEAD:.mise HEAD:bun.lock HEAD:package.json HEAD:bootstrap 2>/dev/null | tr '\n' ' ')
[ -n "$toolchain_key" ] || toolchain_key=$revision
# The tool profiles of the fleet configuration choose what is installed, so a
# changed configuration runs the setup again.
if [ -f "$HOME/.config/dev-fleet/fleet.json" ]; then
  toolchain_key="$toolchain_key$(cksum <"$HOME/.config/dev-fleet/fleet.json" | cut -d' ' -f1)"
fi
if [ "$(cat "$ready_file" 2>/dev/null)" = "$toolchain_key" ] && [ -n "$(find "$ready_file" -mmin -1440 2>/dev/null)" ]; then
  toolchain_warm=1
else
  toolchain_warm=''
  rm -f -- "$status_file" "$ready_file"
fi
bounded='timeout 1800'
# shellcheck disable=SC2086
if [ -z "$toolchain_warm" ] && ! $bounded bash bootstrap/bootstrap.sh --worker --node "$node" --non-interactive --status-file "$status_file" >/dev/null 2>&1; then
  tool_phase=$(sed -n 's/.*"phase":"\([a-z0-9-]*\)".*/\1/p' "$status_file" 2>/dev/null) || tool_phase=''
  case "$tool_phase" in
    managed-config) die TOOLCHAIN_CONFIG_CONFLICT;;
    mise) die TOOLCHAIN_MISE_FAILED;;
    aws) die TOOLCHAIN_AWS_FAILED;;
    t3) die TOOLCHAIN_T3_FAILED;;
    global-config|shell) die TOOLCHAIN_PATH_CONFIGURATION_FAILED;;
    dependencies) die TOOLCHAIN_FROZEN_DEPENDENCIES_FAILED;;
    *) die TOOLCHAIN_CONVERGENCE_FAILED;;
  esac
fi
# A new revision's checkout still needs its own (cached, frozen) dependencies.
if [ -n "$toolchain_warm" ] && [ ! -d node_modules ]; then
  # shellcheck disable=SC2086
  $bounded mise exec --locked bun -- bun install --frozen-lockfile >/dev/null 2>&1 || die TOOLCHAIN_FROZEN_DEPENDENCIES_FAILED
fi
[ -n "$toolchain_warm" ] || printf '%s' "$toolchain_key" >"$ready_file"
# Every synced revision is a full checkout with its own dependencies (about
# 1 GB). Keep this one, the one T3's providers launch from and the two most
# recently used others; the rest would slowly fill the disk.
phase=cleanup
touch "$deployment"
applied=$(basename "$(readlink "$root/current" 2>/dev/null || true)")
kept=0
# shellcheck disable=SC2012
for old in $(ls -1t "$root/revisions"); do
  case "$old" in *[!a-f0-9]*) continue;; esac
  [ "${#old}" = 40 ] || continue
  [ "$old" != "$revision" ] && [ "$old" != "$applied" ] || continue
  kept=$((kept + 1))
  [ "$kept" -gt 2 ] || continue
  rm -rf -- "${root:?}/revisions/$old" || true
done
phase=configuration
operation configuration
trap - EXIT INT TERM
# Node convergence writes its evidence to the result file, not to the SSH
# session: the session may be gone by the time it ends. The evidence is then
# printed for the manager that is still connected, under the same lock.
code=0
mise exec --locked bun -- bun src/node-converge.ts "$node" "$revision" >"$result.partial" 2>"$root/remote-operation.log" || code=$?
mv -f -- "$result.partial" "$result"
operation finished ",\"finished\":$(date +%s),\"exit\":$code"
cat -- "$result" || true
exit "$code"
