/**
 * Candle Fetcher
 * --------------
 * Fetches historical OHLC candle data from App 3 (OTC Live Trading) and
 * builds a per-pair candle map that the backtest + history UI can use to:
 *
 *   1. Determine win/loss for ANY signal — even ones whose source app
 *      doesn't expose an outcome field (notably App 2). We look up the
 *      candle by (pair, ctime) and compare the candle's direction
 *      (close - open) to the signal's direction (CALL/PUT).
 *   2. Render a small candle chart for each pair — open/close (and
 *      high/low for the current candle, via share-signals' prediction_candle).
 *
 * Why this is needed:
 *   - App 1 reports outcomes via its `status` field (WIN/LOSS/DRAW/ACTIVE).
 *   - App 3 reports outcomes via its `result` field (correct/wrong/draw).
 *   - App 2 reports NO outcome at all — its `/api/share-signals` only ever
 *     returns the CURRENT candle's prediction, with no resolution.
 *
 * Before this module, App 2 signals could only be graded when they happened
 * to align with an App 3 signal for the same candle, and the App 3 signal's
 * outcome was used as a proxy. With explicit candle data, we grade every
 * signal independently — which is more accurate and lets the per-pair
 * win rate include App 2's contribution.
 *
 * Data sources:
 *   - https://otc-live-trading-production.up.railway.app/api/signals?limit=N
 *     Each row: { asset, ctime, signal, result, a_open, a_close, ... }
 *     `a_open`/`a_close` are the actual candle open/close prices.
 *   - https://otc-live-trading-production.up.railway.app/api/share-signals
 *     Each row: { asset, time, signal, prediction_candle: {open, high, low, close} }
 *
 * The cache is in-memory and pinned to globalThis so all route handlers
 * share one fetch. TTL is short (30s) because we want fresh prices for
 * the chart, but we DON'T prune historical candles — those are stable
 * forever (a closed candle never changes), so we keep them for the
 * lifetime of the process.
 */

import { fetchJsonWithTimeout } from "./backtest-fetcher";
import {
  canonicalPair,
  candleFloor,
  pickArray,
  pickField,
  parseDirection,
  toUnixSeconds,
  PAIR_KEYS,
  DIRECTION_KEYS,
} from "./signal-normalize";

const APP3_HIST_URL =
  "https://otc-live-trading-production.up.railway.app/api/signals?limit=500";
const APP3_LIVE_URL =
  "https://otc-live-trading-production.up.railway.app/api/share-signals";

/** How often to re-fetch the historical candle set. */
const REFETCH_MS = 30_000;
/** How long to keep the "last fetch failed" status before retrying. */
const FAIL_BACKOFF_MS = 5_000;

export interface Candle {
  /** Canonical pair key, e.g. "USDCOP_otc". */
  pair: string;
  /** Candle open time, unix seconds (minute-floored). */
  candleTime: number;
  open: number;
  high: number | null;
  low: number | null;
  close: number;
  /** App 3's own verdict for this candle: "correct"/"wrong"/"draw"/null. */
  result: "correct" | "wrong" | "draw" | null;
  /** App 3's signal direction for this candle (we use it only to detect
   *  when App 3 had no signal — the candle still exists, just no signal). */
  app3Direction: "CALL" | "PUT" | null;
  /** When we fetched this row (unix ms). */
  fetchedAt: number;
}

export interface CandleLookupResult {
  candle: Candle | null;
  /** Computed outcome for a signal on this candle. */
  outcome: "WIN" | "LOSS" | "DRAW" | "UNKNOWN";
}

interface CandleCacheState {
  /** pair -> candleTime -> Candle (most recent close prices). */
  candles: Map<string, Map<number, Candle>>;
  lastFetchAt: number;
  lastFetchOk: boolean;
  fetchInProgress: boolean;
  totalCandles: number;
}

const GLOBAL_KEY = "__qxCandleCache__";

function getState(): CandleCacheState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      candles: new Map(),
      lastFetchAt: 0,
      lastFetchOk: false,
      fetchInProgress: false,
      totalCandles: 0,
    } satisfies CandleCacheState;
  }
  return g[GLOBAL_KEY] as CandleCacheState;
}

/**
 * Compute win/loss/draw for a signal given the candle it was predicting.
 *
 *   - CALL wins when close > open  (price went up)
 *   - PUT  wins when close < open  (price went down)
 *   - DRAW when close === open     (no movement — neither won nor lost)
 *
 * Returns "UNKNOWN" when the candle data is missing (the candle hasn't
 * closed yet, or App 3 doesn't track this pair).
 */
export function gradeSignalAgainstCandle(
  direction: "CALL" | "PUT",
  candle: Candle | null
): "WIN" | "LOSS" | "DRAW" | "UNKNOWN" {
  if (!candle) return "UNKNOWN";
  // Candle hasn't closed yet — close would equal the live price, which is
  // not authoritative. We mark it UNKNOWN so the UI shows "pending" rather
  // than a wrong verdict.
  if (candle.close == null || !Number.isFinite(candle.close)) return "UNKNOWN";
  if (candle.open == null || !Number.isFinite(candle.open)) return "UNKNOWN";

  const diff = candle.close - candle.open;
  // Use a tiny epsilon so floating-point noise doesn't turn a flat candle
  // into a tiny win. App 3's prices typically have 5-6 significant digits;
  // a 1e-9 epsilon is well below that.
  const EPS = 1e-9;
  if (Math.abs(diff) < EPS) return "DRAW";
  if (direction === "CALL") return diff > 0 ? "WIN" : "LOSS";
  // PUT
  return diff < 0 ? "WIN" : "LOSS";
}

/**
 * Insert/refresh a candle entry. Existing candles are overwritten with the
 * freshest data (App 3 revises a_close as the candle settles; we want the
 * latest value), except for the close price — once a candle has a non-null
 * close, we trust it (a re-fetch mid-candle might give us a transient close
 * from a partial candle that hasn't actually closed yet).
 */
function upsertCandle(st: CandleCacheState, c: Candle): void {
  let pairMap = st.candles.get(c.pair);
  if (!pairMap) {
    pairMap = new Map();
    st.candles.set(c.pair, pairMap);
  }
  pairMap.set(c.candleTime, c);
}

/**
 * Fetch and normalize App 3's historical signal list into Candle entries.
 *
 * App 3's row shape (from /api/signals?limit=N):
 *   {
 *     asset: "USDCOP_otc",
 *     ctime: 1786648500,
 *     signal: "PUT",
 *     result: "correct" | "wrong" | "draw" | null,
 *     a_open: 3145.51,
 *     a_close: 3145.39,
 *     ...
 *   }
 */
async function fetchHistoricalCandles(): Promise<Candle[]> {
  const data = await fetchJsonWithTimeout(APP3_HIST_URL, 10_000);
  if (!data) return [];
  const rows = pickArray(data, ["signals", "rows", "data"]);
  const out: Candle[] = [];

  for (const row of rows) {
    const pair = canonicalPair(pickField(row, PAIR_KEYS));
    if (!pair) continue;

    const ctime = toUnixSeconds(pickField(row, ["ctime", "candle_time", "time", "ts"]));
    if (!(ctime > 0)) continue;

    const candleTime = candleFloor(ctime);
    const aOpen = Number(pickField(row, ["a_open", "open", "open_price"]));
    const aClose = Number(pickField(row, ["a_close", "close", "close_price"]));
    const aHigh = Number(pickField(row, ["a_high", "high"]));
    const aLow = Number(pickField(row, ["a_low", "low"]));

    // Skip rows with no usable price data — they can't grade anything.
    if (!Number.isFinite(aOpen) || !Number.isFinite(aClose)) continue;

    const resultRaw = String(pickField(row, ["result", "outcome"]) ?? "").toLowerCase();
    const result: Candle["result"] =
      resultRaw === "correct" || resultRaw === "win" ? "correct"
      : resultRaw === "wrong" || resultRaw === "loss" ? "wrong"
      : resultRaw === "draw" ? "draw"
      : null;

    const dir = parseDirection(pickField(row, DIRECTION_KEYS));

    out.push({
      pair,
      candleTime,
      open: aOpen,
      close: aClose,
      high: Number.isFinite(aHigh) ? aHigh : null,
      low: Number.isFinite(aLow) ? aLow : null,
      result,
      app3Direction: dir,
      fetchedAt: Date.now(),
    });
  }

  return out;
}

/**
 * Fetch the CURRENT candle from /api/share-signals. This gives us live
 * OHLC (prediction_candle has open/high/low/close) for the candle in play
 * right now — useful for the chart even though we can't grade it yet.
 */
async function fetchLiveCandles(): Promise<Candle[]> {
  const data = await fetchJsonWithTimeout(APP3_LIVE_URL, 8_000);
  if (!data) return [];
  const rows = pickArray(data, ["signals", "rows", "data"]);
  const out: Candle[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (const row of rows) {
    const pair = canonicalPair(pickField(row, PAIR_KEYS));
    if (!pair) continue;
    const dir = parseDirection(pickField(row, DIRECTION_KEYS));
    const t = toUnixSeconds(pickField(row, ["time", "candle_time", "ctime", "ts"]));
    const candleTime = t > 0 ? candleFloor(t) : candleFloor(nowSec);

    const pc = row?.prediction_candle;
    const o = Number(pc?.open);
    const h = Number(pc?.high);
    const l = Number(pc?.low);
    const c = Number(pc?.close);

    if (!Number.isFinite(o) || !Number.isFinite(c)) continue;

    out.push({
      pair,
      candleTime,
      open: o,
      close: c,
      high: Number.isFinite(h) ? h : null,
      low: Number.isFinite(l) ? l : null,
      result: null, // live candle, not yet resolved
      app3Direction: dir,
      fetchedAt: Date.now(),
    });
  }

  return out;
}

/**
 * Refresh the cache. Called by startCandlePoller() every REFETCH_MS, and
 * also by getCandlesForPair() on first access if the cache is empty.
 *
 * We merge two fetches:
 *   1. Historical (resolved) candles — these carry `result` and `a_close`.
 *   2. Live (current) candle — these carry full OHLC but no result yet.
 *
 * The historical set wins on conflict (it has the authoritative close
 * price); the live set only fills in pairs/candles the historical endpoint
 * hasn't recorded yet.
 */
export async function refreshCandles(): Promise<void> {
  const st = getState();
  if (st.fetchInProgress) return;
  st.fetchInProgress = true;
  try {
    const [hist, live] = await Promise.all([
      fetchHistoricalCandles().catch(() => [] as Candle[]),
      fetchLiveCandles().catch(() => [] as Candle[]),
    ]);

    // Historical first — these are authoritative for closed candles.
    for (const c of hist) upsertCandle(st, c);

    // Live — only insert if we don't already have a candle for this
    // (pair, candleTime) from the historical set, OR if the existing
    // entry is missing high/low (the live set has full OHLC).
    for (const c of live) {
      const pairMap = st.candles.get(c.pair);
      const existing = pairMap?.get(c.candleTime);
      if (!existing) {
        upsertCandle(st, c);
      } else if ((existing.high == null || existing.low == null) && (c.high != null && c.low != null)) {
        // Keep the historical close/result but enrich with live OHLC.
        upsertCandle(st, {
          ...existing,
          high: c.high,
          low: c.low,
          open: c.open,
        });
      }
    }

    st.totalCandles = 0;
    for (const pm of st.candles.values()) st.totalCandles += pm.size;

    st.lastFetchAt = Date.now();
    st.lastFetchOk = true;
  } catch (e) {
    st.lastFetchOk = false;
    console.error("[candle-cache] refresh error:", (e as Error)?.message ?? e);
    // Schedule a quicker retry.
    setTimeout(() => { void refreshCandles(); }, FAIL_BACKOFF_MS).unref?.();
  } finally {
    st.fetchInProgress = false;
  }
}

/**
 * Start the background poller. Idempotent — safe to call from every route
 * handler that needs candle data.
 */
export function startCandlePoller(): void {
  const st = getState();
  if ((st as any)._pollerStarted) return;
  (st as any)._pollerStarted = true;
  // Kick off the first fetch immediately.
  void refreshCandles();
  // Then poll on the refresh interval. setTimeout-based loop so we don't
  // pile up fetches if one takes longer than the interval.
  const loop = () => {
    void refreshCandles().finally(() => {
      const t = setTimeout(loop, REFETCH_MS);
      t.unref?.();
    });
  };
  const t = setTimeout(loop, REFETCH_MS);
  t.unref?.();
  console.log(`[candle-cache] started — refreshing every ${REFETCH_MS}ms`);
}

/** Look up the candle for (pair, candleTime). Returns null when unknown. */
export function getCandle(pair: string, candleTimeSec: number): Candle | null {
  const st = getState();
  const pm = st.candles.get(canonicalPair(pair));
  if (!pm) return null;
  return pm.get(candleFloor(candleTimeSec)) ?? null;
}

/**
 * Look up a candle AND compute the win/loss outcome for a signal.
 *
 * This is the canonical way to grade a signal: even if the source app
 * doesn't report an outcome, we grade against the actual candle close.
 */
export function gradeSignal(
  pair: string,
  candleTimeSec: number,
  direction: "CALL" | "PUT"
): CandleLookupResult {
  const candle = getCandle(pair, candleTimeSec);
  return { candle, outcome: gradeSignalAgainstCandle(direction, candle) };
}

/**
 * All candles for a pair, sorted newest-first. Used by the chart component.
 *
 * If `minCount` is given and we have fewer than that, we'll trigger a
 * background refresh (the caller will get the stale set this time and a
 * fresh set on next render).
 */
export function getCandlesForPair(pair: string, minCount?: number): Candle[] {
  const st = getState();
  const pm = st.candles.get(canonicalPair(pair));
  const out: Candle[] = pm ? Array.from(pm.values()) : [];
  out.sort((a, b) => b.candleTime - a.candleTime);
  if (minCount && out.length < minCount) {
    // Trigger a refresh in the background — caller gets stale data now,
    // fresh data on next poll.
    void refreshCandles();
  }
  return out;
}

/** Total candles cached across all pairs. */
export function getTotalCandles(): number {
  return getState().totalCandles;
}

/** Diagnostics for /api/diag. */
export function getCandleCacheStats() {
  const st = getState();
  return {
    running: !!(st as any)._pollerStarted,
    lastFetchAt: st.lastFetchAt,
    lastFetchAgeMs: st.lastFetchAt > 0 ? Date.now() - st.lastFetchAt : -1,
    lastFetchOk: st.lastFetchOk,
    totalCandles: st.totalCandles,
    pairs: st.candles.size,
  };
}

/** Test-only: drop the cache. */
export function resetCandleCacheForTests(): void {
  const st = getState();
  st.candles.clear();
  st.totalCandles = 0;
  st.lastFetchAt = 0;
  st.lastFetchOk = false;
}
