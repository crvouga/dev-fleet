#!/bin/sh
# Keep the worker T3 desktop app (UI and server) up, responsive and on the
# installed release. Run every minute by personal-worker-recovery.timer
# (managed by fleet-sync, tasks/recovery.yml), from the stable copy the role
# installs beside t3-idle.py.
# - The former headless server is stopped and disabled: one T3 per worker.
# - No graphical session: T3_NO_GRAPHICAL_SESSION; after three checks in a row
#   the display manager is restarted so auto-login starts one, three times at
#   most until a session is seen again.
# - Stopped or failed: reset its start limit and start it.
# - Running but its local API has not answered for three checks in a row:
#   restart it, since a hung server serves no turns.
# - Running another release than the installed one, or a policy restart that
#   was deferred: restart it once it runs no agent turn (T3_RESTART_PENDING).
set -u
url=http://127.0.0.1:3773/.well-known/t3/environment
unit=t3code-desktop.service
runtime="${XDG_RUNTIME_DIR:?}"
failures="$runtime/personal-t3-health-failures"
no_session="$runtime/personal-t3-no-session"
display_restarts="$runtime/personal-t3-display-restarts"
pending="$runtime/personal-t3-restart-pending"
restarted="$runtime/personal-t3-restarted-for"
installed="${T3_DESKTOP_DIR:-/opt/T3 Code (Nightly)}/.personal-fleet-version"
here=$(dirname "$0")
limit=3

count() {
  n=$(($(cat "$1" 2>/dev/null || echo 0) + 1))
  echo "$n" > "$1"
  echo "$n"
}

if systemctl --user is-active --quiet t3code.service ||
  systemctl --user is-enabled --quiet t3code.service; then
  echo "Retiring the former headless T3 server."
  if ! systemctl --user disable --now t3code.service; then
    echo "T3_LEGACY_SERVER_RUNNING"
    exit 1
  fi
fi

if ! systemctl --user is-active --quiet graphical-session.target; then
  rm -f "$failures"
  seen=$(count "$no_session")
  echo "T3_NO_GRAPHICAL_SESSION ($seen/$limit)."
  if [ "$seen" -ge "$limit" ]; then
    rm -f "$no_session"
    restarts=$(count "$display_restarts")
    if [ "$restarts" -le "$limit" ]; then
      echo "Restarting the display manager so auto-login starts a session ($restarts/$limit)."
      sudo -n systemctl restart display-manager.service
    else
      echo "The display manager was restarted $limit times; a person must log in."
    fi
  fi
  exit 1
fi
rm -f "$no_session" "$display_restarts"

if ! systemctl --user is-active --quiet "$unit"; then
  rm -f "$failures"
  echo "T3 is not running; starting it."
  systemctl --user reset-failed "$unit" 2>/dev/null
  exec systemctl --user start "$unit"
fi
if ! environment=$(curl --fail --silent --max-time 10 "$url"); then
  failed=$(count "$failures")
  echo "T3 local API did not answer ($failed/$limit)."
  if [ "$failed" -ge "$limit" ]; then
    rm -f "$failures"
    echo "T3 is unresponsive; restarting it."
    systemctl --user reset-failed "$unit" 2>/dev/null
    exec systemctl --user restart "$unit"
  fi
  exit 0
fi
rm -f "$failures"

running=$(printf '%s' "$environment" | sed -n 's/.*"serverVersion" *: *"\([^"]*\)".*/\1/p')
release=$(sed -n 's/^T3-Code-\(.*\)-[a-z0-9]*\.deb$/\1/p' "$installed" 2>/dev/null)
reason=
[ -f "$pending" ] && reason="the staged policy"
if [ -n "$release" ] && [ "$running" != "$release" ]; then
  # One restart per release: a server that still reports another version
  # after it is never restarted in a loop.
  if [ "$(cat "$restarted" 2>/dev/null)" = "$release" ]; then
    echo "T3_RUNNING_VERSION_MISMATCH: restarted for $release, still reports ${running:-nothing}."
    exit 1
  fi
  reason="release $release"
else
  rm -f "$restarted"
fi
[ -z "$reason" ] && exit 0
if python3 -I -B "$here/t3-idle.py" --state "${T3CODE_HOME:-$HOME/.t3}/userdata/statev2.sqlite"; then
  rm -f "$pending"
  [ "$reason" = "release $release" ] && echo "$release" > "$restarted"
  echo "T3 runs no agent turn; restarting it to load $reason."
  systemctl --user reset-failed "$unit" 2>/dev/null
  exec systemctl --user restart "$unit"
fi
echo "T3_RESTART_PENDING: agent turns are running; $reason loads at the first idle check."
exit 0
