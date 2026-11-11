#!/usr/bin/env bash
# Installs the pinned toolchain for the checkout this script is in. fleet-sync
# runs it on every machine from the checkout of the revision it applies;
# nobody clones dev-fleet to use it (see README.md).
set -euo pipefail
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
[[ -f "$script_dir/../mise.toml" ]] || {
  echo 'Run this from a dev-fleet checkout. To use dev-fleet, run its CLI instead: fleet-sync installs the toolchain.' >&2; exit 1;
}
checkout=$(cd "$script_dir/.." && pwd)
cd "$checkout"
# mise is pinned where every other tool is: `min_version` in mise.toml is the
# version installed, and [vars] holds the digest of its release archive for
# each platform. mise cannot read them for us before it exists.
pin() { sed -n "s/^$1 = \"\\(.*\\)\"\$/\\1/p" "$checkout/mise.toml" | head -n 1; }
MISE_VERSION=$(pin min_version)
mise_sha256=$(pin "mise_${platform}_${arch}_sha256")
[[ -n "$MISE_VERSION" && -n "$mise_sha256" ]] || {
  echo 'mise.toml does not pin mise for this platform.' >&2; exit 1;
}
# Reuse an observed matching managed executable. Repeated reconciliation must
# not download/reinstall mise solely because a previous run finished.
installed_mise=$("$HOME/.local/bin/mise" --version 2>/dev/null | awk '{print $1}') || installed_mise=''
if [[ "$installed_mise" != "$MISE_VERSION" ]]; then
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
asset="mise-v${MISE_VERSION}-${platform}-${arch}.tar.gz"
# Alpine/musl is not part of the supported workstation baseline.
curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/$asset" -o "$temp/$asset"
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$temp/$asset" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$temp/$asset" | cut -d' ' -f1)
fi
[[ "$actual" == "$mise_sha256" ]] || {
  echo 'The mise archive does not match the digest pinned in mise.toml.' >&2; exit 1;
}
tar -xzf "$temp/$asset" -C "$temp"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$temp/mise/bin/mise" "$HOME/.local/bin/mise"
fi
export PATH="$HOME/.local/bin:$PATH"
# Trust the checkout directory, not only its file, so `mise trust --show` there
# reports trusted.
mise trust "$checkout"
mise install --locked bun
mise exec --locked bun -- bun bootstrap/setup.ts "$@"
