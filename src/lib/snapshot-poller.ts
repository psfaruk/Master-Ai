/**
 * Background poller — runs inside the Next.js server process.
 *
 * ADAPTIVE polling:
 *   - During the first BURST_WINDOW_SEC of each candle (i.e. when
 *     unix_seconds % 60 < BURST_WINDOW_SEC), poll every BURST_INTERVAL_MS.
 *   - For the rest of the candle, poll every IDLE_INTERVAL_MS.
 *
 * This is the key fix for the "signals appear 27-32s late" complaint. The
 * source apps publish their next-candle signal within a few seconds of a
 * new candle opening; the old fixed 5s interval could land up to 5s late
 * on top of the source's own latency, and combined with the client's own
 * poll cadence the dashboard sometimes didn't show a signal until 30+s
 * into the candle. The burst interval (800ms) means we capture the source
 * app's new signal within ~1s of it being emitted.
 *
 * State is pinned to `globalThis`, same as app2-cache.ts and for the same
 * reason: Next.js dev hot-reload (and multiple route modules importing this
 * file) would otherwise get a fresh `started = false` on every reload and
 * spin up a SECOND interval while the first one — still referenced by its
 * own closure — keeps running too. Module-local state doesn't survive a
 * reload; a global does.
 */

import { aggregateSignals, type AggregatedResponse } from "./signal-aggregator";
import { startApp2CachePoller } from "./app2-cache";

/** Fast poll interval — used during the first BURST_WINDOW_SEC of a candle. */
const BURST_INTERVAL_MS = 800;
/** Slow poll interval — used for the remainder of the candle. */
const IDLE_INTERVAL_MS = 3000;
/** Window after candle open during which we poll fast. */
const BURST_WINDOW_SEC = 12;
/** Fallback interval if adaptive computation fails (defensive). */
const FALLBACK_INTERVAL_MS = 2000;

interface SnapshotPollerState {
  cachedSnapshot: AggregatedResponse | null;
  lastPollAt: number;
  pollInProgress: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
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

/**
 * Compute the gap until the next poll, based on how far into the current
 * minute we are. We poll fast during the first BURST_WINDOW_SEC of a candle
 * (when new signals are arriving) and slow for the rest of the minute.
 */
function nextGapMs(): number {
  const now = Date.now();
  const secIntoCandle = Math.floor(now / 1000) % 60;
  if (secIntoCandle < BURST_WINDOW_SEC) {
    return BURST_INTERVAL_MS;
  }
  return IDLE_INTERVAL_MS;
}

async function pollOnce(): Promise<void> {
  const st = getState();
  if (st.pollInProgress) return;
  st.pollInProgress = true;
  try {
    const snap = await aggregateSignals(1800);
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

/**
 * Self-rescheduling loop. We use setTimeout (not setInterval) so we can
 * vary the gap on every iteration — a fixed interval would either be too
 * slow during the candle-open burst or too fast (wasteful) for the rest
 * of the minute.
 */
function scheduleNext(): void {
  const st = getState();
  if (st.pollTimer) return; // already scheduled
  const gap = nextGapMs();
  st.pollTimer = setTimeout(async () => {
    st.pollTimer = null;
    await pollOnce();
    // Re-arm immediately so the loop continues. We don't await pollOnce()
    // in the timeout callback above to keep the cadence tight — the next
    // poll starts as soon as the previous one finishes, regardless of how
    // long the fetch took. If the fetch overran its slot, the next gap is
    // computed against the (now later) wall clock and will be the idle
    // interval unless we're still inside the burst window.
    scheduleNext();
  }, gap);
  // Don't hold the process open just for this poller.
  (st.pollTimer as any)?.unref?.();
}

/** Start the background poller (idempotent — safe to call multiple times). */
export function startPoller(): void {
  const st = getState();
  if (st.started) return;
  st.started = true;
  // Start the App 2 historical-signal cache poller too (it runs in parallel).
  startApp2CachePoller();
  // Kick off the first poll immediately (async, don't block).
  void pollOnce();
  scheduleNext();
  console.log(
    `[poller] started — adaptive (burst ${BURST_INTERVAL_MS}ms for first ${BURST_WINDOW_SEC}s of each candle, then ${IDLE_INTERVAL_MS}ms)`
  );
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
