#!/usr/bin/env bash
# Private macOS workstation installer; invoke with dev-fleet tools docker-setup.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
case "$(uname -s)/$(uname -m)" in
Darwin/arm64) docker_arch=arm64 ;;
Darwin/x86_64) docker_arch=amd64 ;;
*)
  echo 'Docker Desktop setup is supported here only on macOS.' >&2
  exit 2
  ;;
esac
if [[ ! -d /Applications/Docker.app ]]; then
  read -r docker_build docker_hash < <(mise exec -- bun -e '
    const {vars}=Bun.TOML.parse(await Bun.file("mise.toml").text());
    console.log(vars.docker_desktop_build,vars["docker_desktop_"+process.argv[1]+"_sha256"]);
  ' "$docker_arch")
  [[ "$docker_build" =~ ^[0-9]+$ && "$docker_hash" =~ ^[a-f0-9]{64}$ ]]
  docker_cache="${XDG_CACHE_HOME:-$HOME/.cache}/personal/docker-desktop/$docker_build/$docker_arch"
  mkdir -p "$docker_cache"
  docker_image="$docker_cache/Docker.dmg"
  if ! echo "$docker_hash  $docker_image" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl --fail --location --retry 3 "https://desktop.docker.com/mac/main/$docker_arch/$docker_build/Docker.dmg" -o "$docker_image"
  fi
  echo "$docker_hash  $docker_image" | shasum -a 256 -c -
  docker_mount=$(mktemp -d)
  trap 'hdiutil detach "$docker_mount" >/dev/null 2>&1 || true; rmdir "$docker_mount" 2>/dev/null || true' EXIT
  hdiutil attach "$docker_image" -nobrowse -mountpoint "$docker_mount"
  codesign --verify --deep --strict "$docker_mount/Docker.app"
  ditto "$docker_mount/Docker.app" /Applications/Docker.app
fi
open -a /Applications/Docker.app
printf '%s\n' 'Docker Desktop opened. Complete any first-run agreement/setup in the app, then rerun dev-fleet tools check --docker.'
