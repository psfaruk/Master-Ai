/**
 * App 2 Historical Signal Cache
 * --------------------------------
 * App 2's `/api/share-signals` only returns the CURRENT candle's snapshot.
 * Once a new candle starts, the previous signal is gone. To build a proper
 * candle-aligned consensus across the 3 apps, we need App 2's signal for
 * each historical candle — not just the current one.
 *
 * This module polls App 2 every 5s (in the background) and stores, for each
 * (pair, candleMinute), the latest non-NEUTRAL signal App 2 produced. The
 * aggregator then reads from this cache to align with App 1 and App 3.
 *
 * The cache is in-memory (per Next.js process) and keeps the last
 * CACHE_TTL_MS of history.
 */

import { fetchJsonWithTimeout } from "./backtest-fetcher";

const APP2_URL = "https://binary-signals-app-production.up.railway.app/api/share-signals";
const POLL_INTERVAL_MS = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000; // keep 1 hour of history

interface CachedSignal {
  pair: string;
  signal: "CALL" | "PUT";
  confidence: number; // 0-1
  strength: string | null;
  candleTime: number; // unix seconds, minute-floored
  capturedAt: number; // unix ms when we observed this
  buyerPct: number | null;
  sellerPct: number | null;
}

/**
 * Map of pair -> candleTime -> CachedSignal.
 * For each pair, we keep the latest non-NEUTRAL signal per candle minute.
 */
const cache = new Map<string, Map<number, CachedSignal>>();

let lastPollAt = 0;
let pollInProgress = false;
let pollStarted = false;

/** Parse "HH:MM" string into a unix-seconds candleTime for today (UTC). */
function parseCandleTime(timeStr: string, fallbackSec: number): number {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return Math.floor(fallbackSec / 60) * 60;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return Math.floor(fallbackSec / 60) * 60;
  const now = new Date(fallbackSec * 1000);
  const dt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0) / 1000;
  let ts = dt;
  // If the parsed time is far in the future, it's yesterday's candle.
  if (ts - fallbackSec > 12 * 3600) ts -= 24 * 3600;
  return Math.floor(ts / 60) * 60;
}

async function pollApp2(): Promise<void> {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const data = await fetchJsonWithTimeout(APP2_URL, 8000);
    if (!data || !Array.isArray(data?.rows)) {
      lastPollAt = Date.now();
      return;
    }
    const serverTs = Number(data?.timestamp ?? 0);
    const serverSec = serverTs > 1e12 ? Math.floor(serverTs / 1000) : Math.floor(serverTs);
    const nowSec = Math.floor(Date.now() / 1000);
    // Use server's timestamp if available, else local now.
    const refSec = serverSec > 0 ? serverSec : nowSec;

    for (const r of data.rows) {
      const pair = r?.pair;
      const rawSignal = String(r?.signal ?? "").toUpperCase().trim();
      if (!pair) continue;
      if (rawSignal !== "CALL" && rawSignal !== "PUT") continue; // skip NEUTRAL / —

      const timeStr = String(r?.time ?? "");
      const candleTime = parseCandleTime(timeStr, refSec);
      const conf100 = typeof r?.confidence === "number" ? r.confidence : 0;
      const confidence = conf100 > 0 ? conf100 / 100 : null;
      const strength = typeof r?.strength === "string" ? r.strength.toUpperCase() : null;

      let pairCache = cache.get(pair);
      if (!pairCache) {
        pairCache = new Map();
        cache.set(pair, pairCache);
      }
      // Only store if this candle's signal isn't already cached (keep earliest
      // capture for that candle so the timestamp reflects when the signal
      // was first produced — but update if confidence changes).
      const existing = pairCache.get(candleTime);
      const capturedAt = Date.now();
      if (!existing) {
        pairCache.set(candleTime, {
          pair,
          signal: rawSignal as "CALL" | "PUT",
          confidence: confidence ?? 0,
          strength,
          candleTime,
          capturedAt,
          buyerPct: r?.buyer_pct ?? null,
          sellerPct: r?.seller_pct ?? null,
        });
      }
      // If existing entry exists for this candle, keep it (first capture wins).
      // We could also update confidence here if we want the latest, but
      // first-capture is more deterministic.
    }

    // Prune entries older than CACHE_TTL_MS
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [, pairCache] of cache) {
      for (const [ct, sig] of pairCache) {
        if (sig.capturedAt < cutoff) pairCache.delete(ct);
      }
    }

    lastPollAt = Date.now();
  } catch (e) {
    // Don't crash; just log and continue.
    console.error("[app2-cache] poll error:", (e as Error)?.message ?? e);
    lastPollAt = Date.now();
  } finally {
    pollInProgress = false;
  }
}

/** Start the background poller (idempotent). */
export function startApp2CachePoller(): void {
  if (pollStarted) return;
  pollStarted = true;
  // Kick off the first poll immediately.
  pollApp2();
  setInterval(pollApp2, POLL_INTERVAL_MS);
  console.log(`[app2-cache] started — polling every ${POLL_INTERVAL_MS}ms`);
}

/**
 * Get App 2's cached signal for a specific (pair, candleTime).
 * Returns null if we don't have a cached signal for that candle.
 */
export function getApp2CachedSignal(pair: string, candleTime: number): CachedSignal | null {
  const pairCache = cache.get(pair);
  if (!pairCache) return null;
  return pairCache.get(candleTime) ?? null;
}

/**
 * Get all cached App 2 signals for a pair, as an array.
 * Useful for the aggregator to iterate over historical candles.
 */
export function getApp2CachedSignalsForPair(pair: string): CachedSignal[] {
  const pairCache = cache.get(pair);
  if (!pairCache) return [];
  return Array.from(pairCache.values());
}

/** Returns the timestamp (unix ms) of the last successful poll. */
export function getApp2CacheLastPollAt(): number {
  return lastPollAt;
}

/** Returns the number of (pair, candle) entries currently cached. */
export function getApp2CacheSize(): number {
  let n = 0;
  for (const [, pc] of cache) n += pc.size;
  return n;
}

/** Returns the set of all pairs currently in the cache. */
export function getAllCachedApp2Pairs(): string[] {
  return Array.from(cache.keys());
}

/**
 * Returns ALL cached App 2 signals across all pairs.
 * Used by the aggregator when App 2's live snapshot fails entirely so we
 * can still serve cached historical data.
 */
export function getAllCachedApp2Signals(): CachedSignal[] {
  const out: CachedSignal[] = [];
  for (const [, pc] of cache) {
    for (const [, sig] of pc) out.push(sig);
  }
  return out;
}
