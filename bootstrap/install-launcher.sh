#!/bin/sh
# Links ~/.local/bin/devfleet to this checkout (or the one given). Idempotent.
set -eu
root=${1:-$(cd "$(dirname "$0")/.." && pwd)}
[ -x "$root/bootstrap/devfleet" ] || exit 1
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/bootstrap/devfleet" "$HOME/.local/bin/devfleet"
