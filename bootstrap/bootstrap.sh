#!/usr/bin/env bash
# Download to a file and run with bash; also works directly from a checkout.
set -euo pipefail
MISE_VERSION=2026.10.24
repo=https://github.com/crvouga/dev-fleet.git
os=$(uname -s)
case "$os" in
  Darwin) platform=macos ;;
  Linux) platform=linux ;;
  *) echo 'Use bootstrap.ps1 for native Windows.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo 'Supported: x64 and arm64.' >&2; exit 1 ;;
esac
# Git, TLS roots and extraction are OS prerequisites, outside the mise lock.
if ! git --version >/dev/null 2>&1; then
  case "$os" in
    Darwin)
      xcode-select --install || true
      echo 'Finish installing Apple Command Line Tools, then rerun this script.' >&2
      exit 1 ;;
    Linux)
      if command -v apt-get >/dev/null; then
        sudo apt-get update
        sudo apt-get install -y git curl ca-certificates unzip xz-utils build-essential
      elif command -v dnf >/dev/null; then
        sudo dnf install -y git curl ca-certificates unzip xz gcc gcc-c++ make
      else
        echo 'Install git, curl, CA certificates, unzip, xz and a C/C++ toolchain, then rerun.' >&2
        exit 1
      fi ;;
  esac
fi
for tool in curl tar unzip; do
  command -v "$tool" >/dev/null || { echo "Install $tool, then rerun." >&2; exit 1; }
done
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -f "$script_dir/../mise.toml" ]]; then
  checkout=$(cd "$script_dir/.." && pwd)
else
  checkout=${WORKSPACE_DIR:-"$HOME/workspace"}
  if [[ ! -d "$checkout/.git" ]]; then git clone "$repo" "$checkout"; fi
  [[ "$(git -C "$checkout" remote get-url origin)" == "$repo" ]] || {
    echo "Unexpected checkout at $checkout; choose an empty WORKSPACE_DIR." >&2; exit 1;
  }
fi
cd "$checkout"
# Reuse an observed matching managed executable. Repeated reconciliation must
# not download/reinstall mise solely because a previous run finished.
installed_mise=$("$HOME/.local/bin/mise" --version 2>/dev/null | awk '{print $1}') || installed_mise=''
if [[ "$installed_mise" != "$MISE_VERSION" ]]; then
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
asset="mise-v${MISE_VERSION}-${platform}-${arch}.tar.gz"
# Alpine/musl is not part of the supported workstation baseline.
base="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}"
curl -fsSL "$base/$asset" -o "$temp/$asset"
curl -fsSL "$base/SHASUMS256.txt" -o "$temp/SHASUMS256.txt"
(cd "$temp"; awk -v file="./$asset" '$2 == file { print }' SHASUMS256.txt > check.txt
  test -s check.txt
  if command -v sha256sum >/dev/null; then sha256sum -c check.txt; else shasum -a 256 -c check.txt; fi)
tar -xzf "$temp/$asset" -C "$temp"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$temp/mise/bin/mise" "$HOME/.local/bin/mise"
fi
export PATH="$HOME/.local/bin:$PATH"
mise trust "$checkout/mise.toml"
mise install --locked bun
mise exec --locked bun -- bun bootstrap/setup.ts "$@"
