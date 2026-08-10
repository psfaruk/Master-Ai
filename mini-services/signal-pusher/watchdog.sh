#!/bin/bash
# Restarts the signal-pusher mini-service if it dies.
# Polls every 5s and re-spawns if the port is not listening.

cd /home/z/my-project/mini-services/signal-pusher

while true; do
  if ! ss -tlnp 2>/dev/null | grep -q ":3003 "; then
    echo "[$(date -u +%FT%TZ)] signal-pusher not running, starting..." >> /home/z/my-project/mini-services/signal-pusher/watchdog.log
    setsid nohup bun index.ts > log.txt 2>&1 < /dev/null &
    disown
    sleep 5
  fi
  sleep 5
done
