#!/bin/sh
# Links ~/.local/bin/devfleet to this checkout (or the one given). Idempotent.
set -eu
root=${1:-$(cd "$(dirname "$0")/.." && pwd)}
[ -x "$root/bootstrap/devfleet" ] || exit 1
# Only ever a checkout: an installed package sits wherever a package manager
# put it and may be gone tomorrow.
[ -e "$root/.git" ] || { echo 'The devfleet launcher links to a checkout of dev-fleet; fleet-sync installs it.' >&2; exit 1; }
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/bootstrap/devfleet" "$HOME/.local/bin/devfleet"
