#!/bin/sh
# Keep the worker T3 desktop app (UI and server) up and responsive. Run every minute by
# personal-worker-recovery.timer (managed by fleet-sync, tasks/recovery.yml).
# Stopped or failed: start it. Running but its local API has not answered for
# three checks in a row: restart it, since a hung server serves no turns.
set -u
url=http://127.0.0.1:3773/.well-known/t3/environment
state="${XDG_RUNTIME_DIR:?}/personal-t3-health-failures"
limit=3

# The former headless server still runs until its approved migration; never
# start a second T3 next to it.
if systemctl --user is-active --quiet t3code.service; then
  echo "Headless T3 still runs; desktop migration pending."
  exit 0
fi
if ! systemctl --user is-active --quiet t3code-desktop.service; then
  rm -f "$state"
  echo "T3 is not running; starting it."
  exec systemctl --user start t3code-desktop.service
fi
if curl --fail --silent --max-time 10 --output /dev/null "$url"; then
  rm -f "$state"
  exit 0
fi
failures=$(($(cat "$state" 2>/dev/null || echo 0) + 1))
echo "$failures" > "$state"
echo "T3 local API did not answer ($failures/$limit)."
if [ "$failures" -ge "$limit" ]; then
  rm -f "$state"
  echo "T3 is unresponsive; restarting it."
  exec systemctl --user restart t3code-desktop.service
fi
