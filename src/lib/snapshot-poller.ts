/**
 * Background poller — runs inside the Next.js server process.
 * Every POLL_INTERVAL_MS, fetches a fresh aggregated snapshot from the
 * 3 source apps and caches it in memory. The /api/snapshot endpoint
 * serves the latest cached snapshot so the browser can poll cheaply.
 *
 * This avoids the Caddy/WebSocket upgrade flakiness while still giving
 * real-time updates (5s) to all connected clients.
 */

import { aggregateSignals, type AggregatedResponse } from "./signal-aggregator";

const POLL_INTERVAL_MS = 5000;
const FRESHNESS_WINDOW_SEC = 1800;

let cachedSnapshot: AggregatedResponse | null = null;
let lastPollAt = 0;
let pollInProgress = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

async function pollOnce(): Promise<void> {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const snap = await aggregateSignals(FRESHNESS_WINDOW_SEC);
    cachedSnapshot = snap;
    lastPollAt = Date.now();
  } catch (e) {
    // Don't clear the cached snapshot on error — stale data is better
    // than no data. Just log and move on.
    console.error("[poller] error:", (e as Error)?.message ?? e);
  } finally {
    pollInProgress = false;
  }
}

/** Start the background poller (idempotent — safe to call multiple times). */
export function startPoller(): void {
  if (started) return;
  started = true;
  // Kick off the first poll immediately (async, don't block).
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  console.log(`[poller] started — polling every ${POLL_INTERVAL_MS}ms`);
}

/** Get the latest cached snapshot (or null if first poll hasn't finished). */
export function getSnapshot(): { snapshot: AggregatedResponse | null; ageMs: number } {
  return {
    snapshot: cachedSnapshot,
    ageMs: lastPollAt > 0 ? Date.now() - lastPollAt : -1,
  };
}

/** Force a fresh poll (used by /api/snapshot?refresh=1). */
export async function refreshSnapshot(): Promise<void> {
  await pollOnce();
}
