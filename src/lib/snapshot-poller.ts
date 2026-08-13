/**
 * Background poller — runs inside the Next.js server process.
 * Every POLL_INTERVAL_MS, fetches a fresh aggregated snapshot from the
 * 3 source apps and caches it in memory. The /api/snapshot endpoint
 * serves the latest cached snapshot so the browser can poll cheaply.
 *
 * This avoids the Caddy/WebSocket upgrade flakiness while still giving
 * real-time updates (5s) to all connected clients.
 *
 * State is pinned to `globalThis`, same as app2-cache.ts and for the same
 * reason: Next.js dev hot-reload (and multiple route modules importing this
 * file) would otherwise get a fresh `started = false` on every reload and
 * spin up a SECOND 5s interval while the first one — still referenced by its
 * own closure — keeps running too. Module-local state doesn't survive a
 * reload; a global does.
 */

import { aggregateSignals, type AggregatedResponse } from "./signal-aggregator";
import { startApp2CachePoller } from "./app2-cache";

const POLL_INTERVAL_MS = 5000;
const FRESHNESS_WINDOW_SEC = 1800;

interface SnapshotPollerState {
  cachedSnapshot: AggregatedResponse | null;
  lastPollAt: number;
  pollInProgress: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  started: boolean;
}

const GLOBAL_KEY = "__qxSnapshotPoller__";

function getState(): SnapshotPollerState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      cachedSnapshot: null,
      lastPollAt: 0,
      pollInProgress: false,
      pollTimer: null,
      started: false,
    } satisfies SnapshotPollerState;
  }
  return g[GLOBAL_KEY] as SnapshotPollerState;
}

async function pollOnce(): Promise<void> {
  const st = getState();
  if (st.pollInProgress) return;
  st.pollInProgress = true;
  try {
    const snap = await aggregateSignals(FRESHNESS_WINDOW_SEC);
    st.cachedSnapshot = snap;
    st.lastPollAt = Date.now();
  } catch (e) {
    // Don't clear the cached snapshot on error — stale data is better
    // than no data. Just log and move on.
    console.error("[poller] error:", (e as Error)?.message ?? e);
  } finally {
    st.pollInProgress = false;
  }
}

/** Start the background poller (idempotent — safe to call multiple times). */
export function startPoller(): void {
  const st = getState();
  if (st.started) return;
  st.started = true;
  // Start the App 2 historical-signal cache poller too (it runs in parallel).
  startApp2CachePoller();
  // Kick off the first poll immediately (async, don't block).
  pollOnce();
  st.pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  // Don't hold the process open just for this poller.
  (st.pollTimer as any)?.unref?.();
  console.log(`[poller] started — polling every ${POLL_INTERVAL_MS}ms`);
}

/** Get the latest cached snapshot (or null if first poll hasn't finished). */
export function getSnapshot(): { snapshot: AggregatedResponse | null; ageMs: number } {
  const st = getState();
  return {
    snapshot: st.cachedSnapshot,
    ageMs: st.lastPollAt > 0 ? Date.now() - st.lastPollAt : -1,
  };
}

/** Force a fresh poll (used by /api/snapshot?refresh=1). */
export async function refreshSnapshot(): Promise<void> {
  await pollOnce();
}
