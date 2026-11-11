#!/bin/sh
# Manager-led, explicitly approved initial privilege step. Run through a real
# SSH terminal so sudo reads the operator's password itself; never capture it.
set -eu
umask 077
case "$(uname -s)" in
  Linux)
    . /etc/os-release
    [ "$ID" = ubuntu ] && [ "$VERSION_ID" = 26.04 ] || exit 1 ;;
  Darwin)
    [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ] || exit 1 ;;
  *) exit 1 ;;
esac
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
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || exit 1
else
  python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 9>&9 || exit 1
fi
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
group=root
[ "$(uname -s)" != Darwin ] || group=wheel
sudo -n install -o root -g "$group" -m 0440 -- "$file" "$target"
sudo -n true
