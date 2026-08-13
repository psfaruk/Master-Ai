#!/bin/bash
# Restarts the signal-pusher mini-service if it dies.
# Polls every 5s and re-spawns if the port is not listening.
#
# The path used to be hardcoded to /home/z/my-project, which only existed on
# the machine this was first written on — everywhere else the `cd` failed and
# the watchdog silently supervised the wrong directory.

set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3003}"

while true; do
  if ! ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
    echo "[$(date -u +%FT%TZ)] signal-pusher not listening on ${PORT}, starting..." >> watchdog.log
    setsid nohup bun index.ts > log.txt 2>&1 < /dev/null &
    disown
    sleep 5
  fi
  sleep 5
done
