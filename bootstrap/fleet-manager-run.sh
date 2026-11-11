#!/bin/sh
# Every fleet-sync on the manager runs through this, whether started there or
# handed off from a worker over strict SSH. Runs fleet-sync from a clean,
# fleet-owned checkout of the exact approved revision, so the result never
# depends on the working tree it was started in (uncommitted edits, another
# branch, a removed worktree). Checkouts are reused when warm and pruned to the
# three most recent plus the one T3's providers launch from. Never touches the
# human's working tree.
set -eu
revision=$1
shift
case "$revision" in *[!a-f0-9]*|'') exit 2;; esac
[ "${#revision}" = 40 ] || exit 2
say() { printf 'fleet-sync (manager): %s\n' "$1" >&2; }
# The dev-fleet clone to take the revision from: named by the caller, or the
# one the devfleet launcher is linked into.
repo=${DEVFLEET_REPO:-}
if [ -z "$repo" ]; then
  launcher=$(command -v devfleet) || { say 'set DEVFLEET_REPO to a dev-fleet clone, or install the launcher with sh bootstrap/install-launcher.sh.'; exit 3; }
  repo=$(dirname "$(readlink -f "$launcher")")
fi
repo=$(git -C "$repo" rev-parse --show-toplevel) || { say 'cannot locate the dev-fleet clone on the manager.'; exit 3; }
runs="$HOME/.local/share/personal/fleet/manager-runs"
dir="$runs/$revision"
ready() {
  [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$revision" ] &&
    [ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ]
}
if ! ready; then
  git -C "$repo" cat-file -e "$revision^{commit}" 2>/dev/null || git -C "$repo" fetch --quiet origin || true
  git -C "$repo" cat-file -e "$revision^{commit}" 2>/dev/null || { say "revision $revision is neither on the manager nor on origin; push it first."; exit 4; }
  mkdir -p "$runs"
  chmod 700 "$runs"
  # A fleet-owned, disposable run checkout: recreate it when stale or dirty.
  if [ -e "$dir" ]; then git -C "$repo" worktree remove --force "$dir" 2>/dev/null || rm -rf -- "$dir"; fi
  git -C "$repo" worktree prune
  git -C "$repo" worktree add --quiet --detach "$dir" "$revision"
fi
touch "$dir"
cd "$dir"
mise trust --quiet "$dir" >/dev/null 2>&1 || true
# The manager runs the same locked toolchain (and so the same agent versions)
# as every worker: publish this revision's global config, install it and the
# frozen dependencies. Warm: the toolchain is skipped when the same inputs
# (tool pins, locks, setup code) were installed within a day, so a revision
# that changes none of them only installs its own dependencies.
# Stamp and log sit beside the checkout: inside it they would make it dirty.
stamp="$runs/toolchain-ready"
log="$runs/$revision.setup.log"
key=$(git rev-parse HEAD:mise.toml HEAD:mise.lock HEAD:.mise HEAD:bun.lock HEAD:package.json HEAD:bootstrap 2>/dev/null | tr '\n' ' ')
[ -n "$key" ] || key=$revision
failed() {
  tail -n 20 "$log" >&2
  say "toolchain or dependency install failed in the run checkout; full log: $log"
  exit 5
}
if [ "$(cat "$stamp" 2>/dev/null)" != "$key" ] || [ -z "$(find "$stamp" -mmin -1440 2>/dev/null)" ]; then
  rm -f -- "$stamp"
  mise exec --locked bun -- bun bootstrap/setup.ts --tools-only >"$log" 2>&1 || failed
  printf '%s' "$key" >"$stamp"
fi
if [ ! -d node_modules ]; then
  mise exec --locked bun -- bun install --frozen-lockfile --silent >>"$log" 2>&1 || failed
fi
# Keep the three most recent run checkouts (names are commit SHAs) and the
# applied one: fleet/current points at it and T3's providers launch from there.
applied=$(basename "$(readlink "$(dirname "$runs")/current" 2>/dev/null || true)")
# shellcheck disable=SC2012
for old in $(ls -1td "$runs"/*/ | tail -n +4); do
  [ "$(basename "$old")" != "$applied" ] || continue
  git -C "$repo" worktree remove --force "$old" 2>/dev/null || true
  rm -f -- "${old%/}.setup.log"
done
git -C "$repo" worktree prune
export PERSONAL_WORKSPACE="$dir" PERSONAL_FLEET_RUN_CHECKOUT="$revision"
exec mise exec --locked bun -- bun src/cli/cli.ts fleet-sync --revision "$revision" "$@"
