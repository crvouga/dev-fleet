#!/bin/sh
# Manager-led, explicitly approved initial privilege step. Run through a real
# SSH terminal so sudo reads the operator's password itself; never capture it.
set -eu
umask 077
# Workers are Ubuntu. Which releases is checked by the bootstrap that
# follows, against ansible/ubuntu/policy.json; this only grants sudo.
[ "$(uname -s)" = Linux ] || exit 1
. /etc/os-release
[ "$ID" = ubuntu ] || exit 1
user=$(id -un)
case "$user" in root|''|*[!a-z0-9_-]*) exit 1;; esac
command -v sudo >/dev/null 2>&1 || exit 1
# The same operation lock used by remote bootstrap excludes another installer.
root="$HOME/.local/share/personal/fleet"
for path in "$HOME/.local" "$HOME/.local/share" "$HOME/.local/share/personal" "$root"; do
  [ ! -L "$path" ] || exit 1
done
mkdir -p "$root"
chmod 700 "$root"
[ ! -L "$root/remote-operation.lock" ] || exit 1
exec 9>"$root/remote-operation.lock"
flock -n 9 || exit 1
sudo -v
file=$(mktemp)
trap 'rm -f "$file"' EXIT
trap 'exit 1' HUP INT TERM
printf '# Managed by personal Fleet: designated development user\n%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$user" >"$file"
sudo -n visudo -cf "$file" >/dev/null
# This dedicated path is owned by the same Workstation baseline. Preserve any
# existing fragment for recovery before installing the validated declaration.
target="/etc/sudoers.d/personal-fleet-$user"
if sudo -n test -e "$target"; then
  sudo -n test ! -L "$target" || exit 1
  sudo -n grep -qxF '# Managed by personal Fleet: designated development user' "$target" || {
    printf '%s\n' 'SUDOERS_OWNERSHIP_CONFLICT: preserve the existing fragment and review its source before migration.' >&2
    exit 1
  }
  sudo -n cp -p -- "$target" "$target.before-fleet-enrollment"
fi
sudo -n install -o root -g root -m 0440 -- "$file" "$target"
sudo -n true
