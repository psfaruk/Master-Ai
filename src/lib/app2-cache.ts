/**
 * App 2 Historical Signal Cache
 * --------------------------------
 * App 2's `/api/share-signals` only returns the CURRENT candle's snapshot.
 * Once a new candle starts, the previous signal is gone. To build a proper
 * candle-aligned consensus across the 3 apps, we need App 2's signal for
 * each historical candle — not just the current one.
 *
 * This module polls App 2 every 5s (in the background) and stores, for each
 * (pair, candleMinute), the signal App 2 produced. The aggregator then reads
 * from this cache to align with App 1 and App 3.
 *
 * The cache is in-memory and keeps the last CACHE_TTL_MS of history. It is
 * pinned to `globalThis` so Next.js dev hot-reload (and multiple route modules
 * importing this file) share ONE poller instead of starting a new interval per
 * module instance — the old code leaked a 5s interval on every reload.
 */

import { fetchJsonWithTimeout } from "./backtest-fetcher";
import {
  canonicalPair,
  candleFloor,
  pickArray,
  pickField,
  parseDirection,
  resolveClockToCandle,
  toUnixSeconds,
  PAIR_KEYS,
  DIRECTION_KEYS,
} from "./signal-normalize";

const APP2_URL = "https://binary-signals-app-production.up.railway.app/api/share-signals";
const POLL_INTERVAL_MS = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000; // keep 1 hour of history

export interface CachedSignal {
  pair: string; // canonical pair key
  signal: "CALL" | "PUT";
  confidence: number | null; // 0-1
  strength: string | null;
  candleTime: number; // unix seconds, minute-floored
  /** When we FIRST observed this candle's signal (unix seconds). */
  firstSeenSec: number;
  /** When we last observed it (unix ms) — used for TTL pruning. */
  capturedAt: number;
  buyerPct: number | null;
  sellerPct: number | null;
}

interface App2CacheState {
  /** pair -> candleTime -> CachedSignal */
  cache: Map<string, Map<number, CachedSignal>>;
  lastPollAt: number;
  lastPollOk: boolean;
  lastError: string | null;
  /** Raw row count from the most recent successful poll. */
  lastRawCount: number;
  /** Rows dropped by the most recent poll, by reason — surfaced in /api/diag. */
  lastSkipped: { noPair: number; neutral: number };
  pollInProgress: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

const GLOBAL_KEY = "__qxApp2Cache__";

function getState(): App2CacheState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      cache: new Map(),
      lastPollAt: 0,
      lastPollOk: false,
      lastError: null,
      lastRawCount: 0,
      lastSkipped: { noPair: 0, neutral: 0 },
      pollInProgress: false,
      timer: null,
    } satisfies App2CacheState;
  }
  return g[GLOBAL_KEY] as App2CacheState;
}

/**
 * Normalize one App 2 row into a cache entry.
 *
 * Exported so the aggregator and `/api/diag` parse App 2 rows through exactly
 * the same code path — the old code had three near-identical copies of this
 * parser that had already drifted apart.
 */
export function normalizeApp2Row(row: any, refSec: number): CachedSignal | null {
  const pair = canonicalPair(pickField(row, PAIR_KEYS));
  if (!pair) return null;

  const signal = parseDirection(pickField(row, DIRECTION_KEYS));
  if (!signal) return null; // NEUTRAL / "—" / unknown

  // App 2 reports a wall-clock "HH:MM". Resolve it against the reference
  // clock so a non-UTC render doesn't push the signal hours out of alignment.
  // If the row carries an absolute timestamp, prefer it outright.
  const absolute = toUnixSeconds(
    pickField(row, ["candle_time", "candleTime", "candle_ts", "entry_time", "entryTime"])
  );
  const timeStr = String(pickField(row, ["time", "candle", "clock"]) ?? "");
  const candleTime = absolute > 0 ? candleFloor(absolute) : resolveClockToCandle(timeStr, refSec);
  if (!(candleTime > 0)) return null;

  const rawConf = pickField(row, ["confidence", "conf", "score"]);
  // App 2 sends 0-100; the rest of the app works in 0-1.
  const confNum = typeof rawConf === "number" ? rawConf : Number(rawConf);
  const confidence = Number.isFinite(confNum) && confNum > 0
    ? (confNum > 1 ? confNum / 100 : confNum)
    : null;

  const rawStrength = pickField(row, ["strength", "quality"]);
  const strength = typeof rawStrength === "string" ? rawStrength.toUpperCase() : null;

  const lastUpdate = toUnixSeconds(pickField(row, ["last_update", "lastUpdate", "updated_at", "ts"]));

  const buyer = Number(pickField(row, ["buyer_pct", "buyers", "buyerPct"]));
  const seller = Number(pickField(row, ["seller_pct", "sellers", "sellerPct"]));

  return {
    pair,
    signal,
    confidence,
    strength,
    candleTime,
    firstSeenSec: lastUpdate > 0 ? lastUpdate : refSec,
    capturedAt: Date.now(),
    buyerPct: Number.isFinite(buyer) ? buyer : null,
    sellerPct: Number.isFinite(seller) ? seller : null,
  };
}

/** Insert/refresh one entry, preserving when we first saw this candle. */
function storeEntry(st: App2CacheState, entry: CachedSignal): void {
  let pairCache = st.cache.get(entry.pair);
  if (!pairCache) {
    pairCache = new Map();
    st.cache.set(entry.pair, pairCache);
  }
  const existing = pairCache.get(entry.candleTime);
  if (!existing) {
    pairCache.set(entry.candleTime, entry);
    return;
  }
  // Keep the ORIGINAL first-seen time (that's when App 2 first called this
  // candle) but refresh the payload — App 2 revises confidence and can flip
  // direction mid-candle, and the freshest read is the one it actually stands
  // behind. The old "first capture wins" rule froze a stale direction for the
  // whole candle.
  pairCache.set(entry.candleTime, { ...entry, firstSeenSec: existing.firstSeenSec });
}

/**
 * Record already-normalized App 2 rows into the history cache.
 *
 * The aggregator calls this with every live snapshot it reads, so the cache
 * has two independent writers. If the background poller stalls or was never
 * started (a cold serverless instance, a crashed interval), App 2 history
 * still accumulates from ordinary dashboard traffic instead of silently
 * staying empty — which is what made App 2 vanish from every past candle.
 */
export function recordApp2Signals(entries: CachedSignal[]): void {
  const st = getState();
  for (const entry of entries) storeEntry(st, entry);
}

async function pollApp2(): Promise<void> {
  const st = getState();
  if (st.pollInProgress) return;
  st.pollInProgress = true;
  try {
    const data = await fetchJsonWithTimeout(APP2_URL, 8000);
    const rows = pickArray(data, ["rows", "signals", "data", "items"]);
    if (rows.length === 0) {
      st.lastPollAt = Date.now();
      st.lastPollOk = data != null;
      st.lastRawCount = 0;
      st.lastError = data == null ? "empty_response" : "no_rows";
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const serverSec = toUnixSeconds(data?.timestamp ?? data?.ts ?? data?.server_time);
    // Prefer the upstream clock, but only if it is sane — a wildly skewed
    // upstream clock would otherwise bucket every signal into the wrong candle.
    const refSec = serverSec > 0 && Math.abs(serverSec - nowSec) <= 300 ? serverSec : nowSec;

    const skipped = { noPair: 0, neutral: 0 };

    for (const row of rows) {
      const entry = normalizeApp2Row(row, refSec);
      if (!entry) {
        if (!canonicalPair(pickField(row, PAIR_KEYS))) skipped.noPair++;
        else skipped.neutral++;
        continue;
      }

      storeEntry(st, entry);
    }

    st.lastSkipped = skipped;
    st.lastRawCount = rows.length;
    st.lastPollOk = true;
    st.lastError = null;

    // Prune entries we haven't seen for CACHE_TTL_MS, and drop pairs that end
    // up empty so the pair list doesn't grow forever.
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [pair, pairCache] of st.cache) {
      for (const [ct, sig] of pairCache) {
        if (sig.capturedAt < cutoff) pairCache.delete(ct);
      }
      if (pairCache.size === 0) st.cache.delete(pair);
    }
  } catch (e) {
    st.lastPollOk = false;
    st.lastError = (e as Error)?.message ?? String(e);
    console.error("[app2-cache] poll error:", st.lastError);
  } finally {
    st.lastPollAt = Date.now();
    st.pollInProgress = false;
  }
}

/** Start the background poller (idempotent, survives hot reload). */
export function startApp2CachePoller(): void {
  const st = getState();
  if (st.timer) return;
  // Kick off the first poll immediately.
  void pollApp2();
  st.timer = setInterval(() => { void pollApp2(); }, POLL_INTERVAL_MS);
  // Don't hold the process open just for this poller.
  (st.timer as any)?.unref?.();
  console.log(`[app2-cache] started — polling every ${POLL_INTERVAL_MS}ms`);
}

/** Force one immediate poll and wait for it (used by /api/diag). */
export async function pollApp2Now(): Promise<void> {
  await pollApp2();
}

/** Get App 2's cached signal for a specific (pair, candleTime). */
export function getApp2CachedSignal(pair: string, candleTime: number): CachedSignal | null {
  const st = getState();
  const pairCache = st.cache.get(canonicalPair(pair));
  if (!pairCache) return null;
  return pairCache.get(candleFloor(candleTime)) ?? null;
}

/** All cached App 2 signals for one pair. */
export function getApp2CachedSignalsForPair(pair: string): CachedSignal[] {
  const st = getState();
  const pairCache = st.cache.get(canonicalPair(pair));
  if (!pairCache) return [];
  return Array.from(pairCache.values());
}

/** All cached App 2 signals, across all pairs. */
export function getAllCachedApp2Signals(): CachedSignal[] {
  const st = getState();
  const out: CachedSignal[] = [];
  for (const [, pc] of st.cache) {
    for (const [, sig] of pc) out.push(sig);
  }
  return out;
}

/** Every pair we have ever cached a signal for. */
export function getAllCachedApp2Pairs(): string[] {
  return Array.from(getState().cache.keys());
}

/** Timestamp (unix ms) of the last poll attempt. */
export function getApp2CacheLastPollAt(): number {
  return getState().lastPollAt;
}

/** Number of (pair, candle) entries currently cached. */
export function getApp2CacheSize(): number {
  const st = getState();
  let n = 0;
  for (const [, pc] of st.cache) n += pc.size;
  return n;
}

/**
 * Drop every cached candle. Only used by the test suite — the cache is a
 * process-wide singleton, so tests would otherwise leak state into each other.
 */
export function resetApp2CacheForTests(): void {
  getState().cache.clear();
}

/** Diagnostics for /api/diag. */
export function getApp2CacheStats() {
  const st = getState();
  return {
    running: st.timer != null,
    lastPollAt: st.lastPollAt,
    lastPollAgeMs: st.lastPollAt > 0 ? Date.now() - st.lastPollAt : -1,
    lastPollOk: st.lastPollOk,
    lastError: st.lastError,
    lastRawCount: st.lastRawCount,
    lastSkipped: st.lastSkipped,
    pairs: st.cache.size,
    entries: getApp2CacheSize(),
  };
}
