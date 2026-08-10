#!/bin/bash
# Auto-restart wrapper for the signal-pusher mini-service.
# If bun exits for any reason, this script re-spawns it after 2s.
# This runs as the "dev" script of the mini-service so the parent
# dev.sh keeps us alive for the lifetime of the sandbox.

cd "$(dirname "$0")"

# Make sure dependencies are installed (dev.sh may not have run bun install
# for us if package.json was added after the initial scan).
if [ ! -d "node_modules" ]; then
  echo "[signal-pusher] installing dependencies..."
  bun install
fi

while true; do
  echo "[signal-pusher] starting bun index.ts (PID $$)..."
  bun index.ts
  EXIT_CODE=$?
  echo "[signal-pusher] bun exited with code $EXIT_CODE, restarting in 2s..."
  sleep 2
done
