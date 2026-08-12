/**
 * Signal Aggregator
 * -----------------
 * Fetches call/put signals from 3 Quotex signal apps hosted on Railway,
 * normalizes them into a unified schema, and computes per-pair consensus
 * (2-bot agree / 3-bot agree / conflict / single).
 *
 * Why a server-side aggregator: all 3 source apps lack CORS headers,
 * so the browser cannot call them directly. We fan out server-side.
 */

import { fetchJsonWithTimeout } from "./backtest-fetcher";
import { getApp2CachedSignalsForPair, getAllCachedApp2Signals, getAllCachedApp2Pairs, startApp2CachePoller } from "./app2-cache";

export type Direction = "CALL" | "PUT" | "NEUTRAL";
export type AppId = "app1" | "app2" | "app3";
export type ConsensusLevel =
  | "3-agree"
  | "2-agree"
  | "conflict"
  | "1-only"
  | "none";

export interface SourceSignal {
  source: AppId;
  sourceName: string;
  pair: string; // canonical asset code, e.g. "USDCOP_otc"
  displayPair: string; // e.g. "USD/COP OTC"
  direction: Direction;
  confidence: number | null;
  strength?: string | null;
  timestamp: number; // unix seconds — when the app emitted the signal
  /** Candle time (unix seconds, floored to minute) — the candle this signal
   *  is predicting. This is the key used to align signals across the 3 apps. */
  candleTime: number;
  ageSec: number; // seconds since aggregator call
  outcome?: "WIN" | "LOSS" | "DRAW" | "CORRECT" | "WRONG" | null;
  strategy?: string | null;
  reasons?: string[] | null;
  fresh: boolean; // within freshness window
}

/**
 * A candle-aligned consensus — one of these exists for every (pair, candle)
 * combination where at least one app emitted a signal.
 */
export interface CandleConsensus {
  pair: string;
  displayPair: string;
  category: "otc" | "real";
  candleTime: number; // unix seconds, minute-floored
  signals: SourceSignal[]; // one per app that has a signal for this candle
  freshCount: number;
  callCount: number;
  putCount: number;
  neutralCount: number;
  consensus: {
    level: ConsensusLevel;
    direction: Direction | null;
    agreeingApps: AppId[];
    disagreeingApps: AppId[];
    missingApps: AppId[];
  };
}

export interface PairConsensus {
  pair: string;
  displayPair: string;
  category: "otc" | "real";
  /** Latest signal from each app (for backwards compat / display). */
  signals: SourceSignal[];
  /** Candle-aligned consensus entries — sorted newest first. */
  candles: CandleConsensus[];
  /** The most recent candle where at least 2 apps agree (or the latest candle). */
  latestCandle: CandleConsensus | null;
  freshCount: number;
  callCount: number;
  putCount: number;
  neutralCount: number;
  consensus: {
    level: ConsensusLevel;
    direction: Direction | null;
    agreeingApps: AppId[];
    disagreeingApps: AppId[];
    missingApps: AppId[];
  };
}

export interface AppStatus {
  id: AppId;
  name: string;
  url: string;
  online: boolean;
  lastChecked: number; // unix ms
  signalCount: number;
  freshSignalCount: number;
  health: "ok" | "token_expired" | "disconnected" | "down" | "unknown";
  /** Human-readable health detail shown on the dashboard. */
  detail?: string;
  /** Whether the upstream Quotex WebSocket is live (signals are flowing). */
  live?: boolean;
  /** Whether the upstream token is expired / rejected. */
  tokenExpired?: boolean;
  /** HTTP latency of the signals call, in ms. */
  latencyMs?: number;
  /** Server-reported uptime in seconds, if available. */
  uptimeSec?: number;
  /** Number of active pair streams (App2 only). */
  activeStreams?: number;
  /** Last error message from the fetch, if any. */
  error?: string;
}

export interface AggregatedResponse {
  timestamp: number; // unix ms (server time when aggregation ran)
  freshnessWindowSec: number;
  apps: AppStatus[];
  pairs: PairConsensus[];
  summary: {
    totalPairs: number;
    threeBotAgree: PairConsensus[];
    twoBotAgree: PairConsensus[];
    conflicts: PairConsensus[];
    singleOnly: PairConsensus[];
    pairsByDirection: { CALL: number; PUT: number; NEUTRAL: number; NONE: number };
  };
}

/** Source app definitions. */
const SOURCES = [
  {
    id: "app1" as const,
    name: "Minimum Pair",
    shortName: "App 1",
    baseUrl: "https://minimum-pair-production.up.railway.app",
    signalsPath: "/api/signals",
    healthPath: "/api/health",
    accent: "amber",
  },
  {
    id: "app2" as const,
    name: "Binary Signal Terminal",
    shortName: "App 2",
    baseUrl: "https://binary-signals-app-production.up.railway.app",
    signalsPath: "/api/share-signals",
    healthPath: "/api/status",
    accent: "violet",
  },
  {
    id: "app3" as const,
    name: "OTC Live Trading",
    shortName: "App 3",
    baseUrl: "https://otc-live-trading-production.up.railway.app",
    // share-signals gives us the CURRENT candle's live signal (real-time).
    // We also fetch /api/signals?limit=300 for historical/resolved signals
    // inside fetchApp3() below.
    signalsPath: "/api/share-signals",
    historicalPath: "/api/signals?limit=300",
    healthPath: "/api/token-status",
    accent: "emerald",
  },
] as const;

export function getSources() {
  return SOURCES;
}

/** Convert canonical asset code into a human-readable display pair. */
export function displayPairFromAsset(asset: string): string {
  if (asset.endsWith("_otc")) {
    const base = asset.replace("_otc", "");
    return `${base.slice(0, 3)}/${base.slice(3)} OTC`;
  }
  return `${asset.slice(0, 3)}/${asset.slice(3)}`;
}

function classifyPair(asset: string): "otc" | "real" {
  return asset.endsWith("_otc") ? "otc" : "real";
}

const FETCH_TIMEOUT_MS = 10000;

// fetchJsonWithTimeout is imported from ./backtest-fetcher

// ---- Per-source fetch + normalize ---------------------------------------

interface NormalizeResult {
  signals: SourceSignal[];
  health: AppStatus["health"];
  detail?: string;
  live?: boolean;
  tokenExpired?: boolean;
  uptimeSec?: number;
  activeStreams?: number;
  rawCount: number;
  latencyMs?: number;
  error?: string;
}

// ---- Health endpoint callers ---------------------------------------------
// These hit each source app's dedicated health/status endpoint to derive
// authoritative online state + token state.

async function fetchApp1Health(): Promise<Partial<NormalizeResult>> {
  try {
    const d = await fetchJsonWithTimeout(
      "https://minimum-pair-production.up.railway.app/api/health",
      6000
    );
    if (!d) return { error: "empty_health" };
    const st = d?.status ?? {};
    const tokenExpired = st?.tokenExpired === true || st?.state === "token_expired";
    const live = st?.live === true;
    let health: AppStatus["health"];
    if (tokenExpired) health = "token_expired";
    else if (!live) health = "disconnected";
    else health = "ok";
    return {
      health,
      live,
      tokenExpired,
      detail: st?.detail,
      uptimeSec: typeof st?.uptimeSec === "number" ? st.uptimeSec : undefined,
    };
  } catch {
    return { error: "health_fetch_failed" };
  }
}

async function fetchApp2Health(): Promise<Partial<NormalizeResult>> {
  try {
    const d = await fetchJsonWithTimeout(
      "https://binary-signals-app-production.up.railway.app/api/status",
      6000
    );
    if (!d) return { error: "empty_health" };
    const connected = d?.connected === true;
    const streams: any[] = Array.isArray(d?.streams?.active) ? d.streams.active : [];
    let health: AppStatus["health"];
    if (!connected) health = "disconnected";
    else health = "ok";
    return {
      health,
      live: connected,
      tokenExpired: false, // App2 doesn't expose token state directly
      activeStreams: streams.length,
      detail: connected ? `connected · ${streams.length} streams` : "disconnected",
    };
  } catch {
    return { error: "health_fetch_failed" };
  }
}

async function fetchApp3Health(): Promise<Partial<NormalizeResult>> {
  try {
    const d = await fetchJsonWithTimeout(
      "https://otc-live-trading-production.up.railway.app/api/token-status",
      6000
    );
    if (!d) return { error: "empty_health" };
    const connected = d?.connected === true;
    const hasToken = d?.has_env_token === true || d?.has_user_token === true;
    let health: AppStatus["health"];
    if (!hasToken) health = "token_expired";
    else if (!connected) health = "disconnected";
    else health = "ok";
    return {
      health,
      live: connected,
      tokenExpired: !hasToken,
      detail: d?.token_source ? `token_source=${d.token_source}${connected ? " · connected" : " · disconnected"}` : undefined,
    };
  } catch {
    return { error: "health_fetch_failed" };
  }
}

const HEALTH_FETCHERS: Record<AppId, () => Promise<Partial<NormalizeResult>>> = {
  app1: fetchApp1Health,
  app2: fetchApp2Health,
  app3: fetchApp3Health,
};

/**
 * Merge health-endpoint data into the signals-fetcher result.
 * Health data wins for online/token state because it's authoritative.
 * If the signals fetch failed but health succeeded, we still report the app as online.
 * If health fetch also failed, we fall back to inferring from signals fetch state.
 */
function mergeHealth(
  sigResult: NormalizeResult,
  healthResult: Partial<NormalizeResult> | undefined
): Partial<NormalizeResult> {
  // If signals fetch returned "down" (network error), but health succeeded,
  // trust health. If both failed, mark down.
  if (!healthResult || healthResult.error) {
    // Health fetch failed. If signals also failed, mark down.
    if (sigResult.health === "down") {
      return { health: "down" };
    }
    // Signals succeeded but health fetch failed — keep sigResult.health.
    return {
      detail: sigResult.detail ?? "health check failed (signals OK)",
      live: sigResult.health === "ok",
      tokenExpired: sigResult.health === "token_expired",
    };
  }
  // Health succeeded — use its authoritative state.
  return {
    health: healthResult.health ?? sigResult.health,
    detail: healthResult.detail ?? sigResult.detail,
    live: healthResult.live,
    tokenExpired: healthResult.tokenExpired,
    uptimeSec: healthResult.uptimeSec,
    activeStreams: healthResult.activeStreams,
  };
}

/** App1 (Minimum Pair): /api/signals -> { signals: [...] } */
async function fetchApp1(freshnessWindowSec: number, nowSec: number): Promise<NormalizeResult> {
  const src = SOURCES[0];
  let data: any;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`, FETCH_TIMEOUT_MS);
  } catch {
    return { signals: [], health: "down", rawCount: 0, error: "fetch_failed" };
  }
  if (!data) {
    return { signals: [], health: "down", rawCount: 0, error: "empty_response" };
  }
  const arr: any[] = Array.isArray(data?.signals) ? data.signals : [];
  const health = data?.status?.state === "token_expired" || data?.status?.tokenExpired
    ? "token_expired"
    : "ok";

  // IMPORTANT: We no longer group-by-symbol-to-latest here. We keep ALL
  // signals so the aggregator can align them by candle-time across apps.
  // (The dashboard / backtest will pick the relevant candle.)
  const out: SourceSignal[] = [];
  for (const s of arr) {
    const sym = s?.symbol;
    if (!sym) continue;
    const tsMs = Number(s.signalAt ?? s.entryTime ?? 0);
    const ts = tsMs > 1e12 ? Math.floor(tsMs / 1000) : Math.floor(tsMs);
    const dir = String(s.direction ?? "").toUpperCase() as Direction;
    if (dir !== "CALL" && dir !== "PUT") continue;
    // Candle time = the minute this signal is predicting. App1 has explicit
    // entryTime — use that. Otherwise fall back to the signal timestamp
    // floored to the minute.
    const entryMs = Number(s.entryTime ?? 0);
    const entrySec = entryMs > 1e12 ? Math.floor(entryMs / 1000) : Math.floor(entryMs);
    const candleTime = entrySec > 0 ? Math.floor(entrySec / 60) * 60 : Math.floor(ts / 60) * 60;
    const ageSec = Math.max(0, nowSec - ts);
    out.push({
      source: "app1",
      sourceName: src.name,
      pair: sym,
      displayPair: s.symbolShort ? `${s.symbolShort}${sym.endsWith("_otc") ? " OTC" : ""}` : displayPairFromAsset(sym),
      direction: dir,
      confidence: typeof s.confidence === "number" ? s.confidence : null,
      strength: typeof s.quality === "number" ? (s.quality >= 0.7 ? "STRONG" : s.quality >= 0.45 ? "MEDIUM" : "WEAK") : null,
      timestamp: ts,
      candleTime,
      ageSec,
      outcome: s.status ? (s.status as SourceSignal["outcome"]) : null,
      strategy: s.primaryPattern ?? null,
      reasons: Array.isArray(s.reasons) ? s.reasons : null,
      fresh: ageSec <= freshnessWindowSec,
    });
  }

  return { signals: out, health, rawCount: arr.length };
}

/**
 * App2 (Binary Signal Terminal): /api/share-signals -> { rows: [...] }
 *
 * This endpoint returns a SNAPSHOT of all 15 pairs with their current
 * signal. Each row has: pair, type, time (HH:MM string), signal (CALL/PUT/NEUTRAL/—),
 * confidence (0-100 integer), strength, last_update, live.
 *
 * IMPORTANT: The snapshot only contains the CURRENT candle's signal. Once a
 * new candle starts, the previous signal is gone. To build a proper candle-
 * aligned consensus with App 1 and App 3 (which keep historical data), we
 * also pull from our own App 2 historical cache (see app2-cache.ts) which
 * polls /api/share-signals every 5s and remembers each candle's signal.
 *
 * The aggregator will then have App 2 signals for many historical candles,
 * not just the current one.
 */
async function fetchApp2(freshnessWindowSec: number, nowSec: number): Promise<NormalizeResult> {
  // Ensure the App 2 cache poller is running (idempotent).
  startApp2CachePoller();

  const src = SOURCES[1];
  let data: any;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`, FETCH_TIMEOUT_MS);
  } catch {
    // Even if the live snapshot fails, we can still serve from cache.
    return { signals: getApp2CachedSignalsAllPairs(nowSec, freshnessWindowSec, src.name), health: "down", rawCount: 0, error: "fetch_failed" };
  }

  const arr: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const health = data?.connected === false ? "down" : "ok";
  const serverTs = Number(data?.timestamp ?? 0);
  const serverSec = serverTs > 1e12 ? Math.floor(serverTs / 1000) : Math.floor(serverTs);

  // Build a set of all pairs we know about: from the snapshot AND from our
  // App 2 historical cache. This way even if a pair is currently NEUTRAL in
  // the snapshot, we still pull its historical cached signals.
  const allPairs = new Set<string>();
  for (const r of arr) {
    if (r?.pair) allPairs.add(r.pair);
  }
  for (const p of getAllCachedApp2Pairs()) allPairs.add(p);

  const out: SourceSignal[] = [];
  // Map of (pair|candleTime) -> SourceSignal for dedup
  const seenCandles = new Set<string>();

  // First: current snapshot signals (only non-NEUTRAL ones)
  for (const r of arr) {
    const pair = r?.pair;
    if (!pair) continue;
    const rawSignal = String(r?.signal ?? "").toUpperCase().trim();
    if (rawSignal !== "CALL" && rawSignal !== "PUT") continue;
    const dir = rawSignal as Direction;

    const timeStr = String(r?.time ?? "");
    let candleTime = serverSec > 0 ? Math.floor(serverSec / 60) * 60 : nowSec;
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const hh = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) {
        const now = new Date(nowSec * 1000);
        const dt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0) / 1000;
        let ts = dt;
        if (ts - nowSec > 12 * 3600) ts -= 24 * 3600;
        candleTime = Math.floor(ts / 60) * 60;
      }
    }

    const conf100 = typeof r?.confidence === "number" ? r.confidence : 0;
    const confidence = conf100 > 0 ? conf100 / 100 : null;
    const lastUpdate = Number(r?.last_update ?? 0);
    const ts = lastUpdate > 0 ? Math.floor(lastUpdate) : candleTime;
    const ageSec = Math.max(0, nowSec - ts);
    const strengthStr = typeof r?.strength === "string" ? r.strength.toUpperCase() : null;

    seenCandles.add(`${pair}|${candleTime}`);
    out.push({
      source: "app2",
      sourceName: src.name,
      pair,
      displayPair: displayPairFromAsset(pair),
      direction: dir,
      confidence,
      strength: strengthStr,
      timestamp: ts,
      candleTime,
      ageSec,
      outcome: null,
      strategy: r?.buyer_pct != null && r?.seller_pct != null
        ? `buyers=${r.buyer_pct}% sellers=${r.seller_pct}%`
        : null,
      reasons: null,
      fresh: ageSec <= freshnessWindowSec,
    });
  }

  // Then: pull historical signals from our App 2 cache for ALL known pairs.
  // These are signals from previous candles that the snapshot no longer shows.
  // We dedupe by (pair, candleTime) — current snapshot wins.
  const cachedSignals: SourceSignal[] = [];
  for (const pair of allPairs) {
    const cached = getApp2CachedSignalsForPair(pair);
    for (const c of cached) {
      const key = `${c.pair}|${c.candleTime}`;
      if (seenCandles.has(key)) continue;
      seenCandles.add(key);
      const ageSec = Math.max(0, nowSec - c.candleTime);
      cachedSignals.push({
        source: "app2",
        sourceName: src.name,
        pair: c.pair,
        displayPair: displayPairFromAsset(c.pair),
        direction: c.signal,
        confidence: c.confidence,
        strength: c.strength,
        timestamp: c.candleTime,
        candleTime: c.candleTime,
        ageSec,
        outcome: null,
        strategy: c.buyerPct != null && c.sellerPct != null
          ? `buyers=${c.buyerPct}% sellers=${c.sellerPct}%`
          : null,
        reasons: null,
        fresh: ageSec <= freshnessWindowSec,
      });
    }
  }

  return { signals: [...out, ...cachedSignals], health, rawCount: arr.length };
}

/**
 * Helper: get all cached App 2 signals as SourceSignal[]. Used when the live
 * snapshot fetch fails entirely (so we still have *some* App 2 data from
 * our own historical cache).
 */
function getApp2CachedSignalsAllPairs(nowSec: number, freshnessWindowSec: number, srcName: string): SourceSignal[] {
  const out: SourceSignal[] = [];
  const cached = getAllCachedApp2Signals();
  for (const c of cached) {
    const ageSec = Math.max(0, nowSec - c.candleTime);
    out.push({
      source: "app2",
      sourceName: srcName,
      pair: c.pair,
      displayPair: displayPairFromAsset(c.pair),
      direction: c.signal,
      confidence: c.confidence,
      strength: c.strength,
      timestamp: c.candleTime,
      candleTime: c.candleTime,
      ageSec,
      outcome: null,
      strategy: c.buyerPct != null && c.sellerPct != null
        ? `buyers=${c.buyerPct}% sellers=${c.sellerPct}%`
        : null,
      reasons: null,
      fresh: ageSec <= freshnessWindowSec,
    });
  }
  return out;
}

/**
 * App3 (OTC Live Trading): /api/share-signals (current) + /api/signals?limit=N (historical)
 *
 * App 3 has TWO relevant endpoints:
 *   1. /api/share-signals -> { signals: [...] } — the CURRENT candle's live
 *      signal for all 16 pairs. Each row has: asset, display, type, time
 *      (unix seconds for the candle being predicted), signal, strength,
 *      confidence (0-1 float), prediction_candle {open,high,low,close}.
 *   2. /api/signals?limit=N -> [...] — RESOLVED historical signals (the
 *      candle has closed, result is known: correct/wrong/draw).
 *
 * We need BOTH: the live signal for the current candle (so consensus can
 * align with App 1 and App 2 which also predict the current candle), plus
 * historical signals for backtest win-rate calculation.
 *
 * We merge them, deduping by (pair, candleTime). When both exist for the
 * same candle, the historical one wins (it has the resolved outcome).
 */
async function fetchApp3(freshnessWindowSec: number, nowSec: number): Promise<NormalizeResult> {
  const src = SOURCES[2];
  const out: SourceSignal[] = [];
  const seenCandles = new Set<string>(); // pair|candleTime
  let health: AppStatus["health"] = "ok";
  let rawCount = 0;
  let fetchError: string | undefined;

  // --- 1. Fetch RESOLVED historical signals (these have WIN/LOSS outcomes) ---
  const histUrl = `${src.baseUrl}${(src as any).historicalPath ?? "/api/signals?limit=300"}`;
  try {
    const histData = await fetchJsonWithTimeout(histUrl, FETCH_TIMEOUT_MS);
    if (histData) {
      const arr: any[] = Array.isArray(histData) ? histData : (Array.isArray(histData?.signals) ? histData.signals : []);
      rawCount = arr.length;
      for (const s of arr) {
        const a = s?.asset;
        if (!a) continue;
        const ts = Math.floor(Number(s.ctime ?? 0));
        const dir = String(s.signal ?? "").toUpperCase() as Direction;
        if (dir !== "CALL" && dir !== "PUT") continue;
        const candleTime = Math.floor(ts / 60) * 60;
        const ageSec = Math.max(0, nowSec - ts);
        const key = `${a}|${candleTime}`;
        seenCandles.add(key);
        out.push({
          source: "app3",
          sourceName: src.name,
          pair: a,
          displayPair: displayPairFromAsset(a),
          direction: dir,
          confidence: typeof s.confidence === "number" ? s.confidence : null,
          strength: typeof s.strength === "string" ? s.strength : null,
          timestamp: ts,
          candleTime,
          ageSec,
          outcome: s.result === "correct" ? "CORRECT" : s.result === "wrong" ? "WRONG" : s.result === "draw" ? "DRAW" : null,
          strategy: typeof s.codes === "string" && s.codes ? s.codes : null,
          reasons: null,
          fresh: ageSec <= freshnessWindowSec,
        });
      }
    }
  } catch {
    // Historical fetch failed — keep going, we still want live signals.
  }

  // --- 2. Fetch CURRENT live signals from /api/share-signals ---
  try {
    const liveData = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`, FETCH_TIMEOUT_MS);
    if (liveData) {
      const liveArr: any[] = Array.isArray(liveData?.signals) ? liveData.signals : (Array.isArray(liveData) ? liveData : []);
      for (const r of liveArr) {
        const a = r?.asset;
        if (!a) continue;
        const rawSignal = String(r?.signal ?? "").toUpperCase().trim();
        if (rawSignal !== "CALL" && rawSignal !== "PUT") continue;
        const dir = rawSignal as Direction;
        // App 3's share-signals `time` is a unix-seconds timestamp for the
        // candle being predicted.
        const ts = Math.floor(Number(r?.time ?? 0));
        const candleTime = ts > 0 ? Math.floor(ts / 60) * 60 : Math.floor(nowSec / 60) * 60;
        const key = `${a}|${candleTime}`;
        if (seenCandles.has(key)) continue; // historical already has this candle
        seenCandles.add(key);
        const ageSec = Math.max(0, nowSec - ts);
        out.push({
          source: "app3",
          sourceName: src.name,
          pair: a,
          displayPair: displayPairFromAsset(a),
          direction: dir,
          confidence: typeof r?.confidence === "number" ? r.confidence : null,
          strength: typeof r?.strength === "string" ? r.strength : null,
          timestamp: ts > 0 ? ts : candleTime,
          candleTime,
          ageSec,
          outcome: null, // live signal, not yet resolved
          strategy: null,
          reasons: null,
          fresh: ageSec <= freshnessWindowSec,
        });
      }
    }
  } catch {
    if (out.length === 0) {
      // Both fetches failed
      health = "down";
      fetchError = "fetch_failed";
    }
  }

  return { signals: out, health, rawCount, error: fetchError };
}

// ---- Aggregator entrypoint ----------------------------------------------

export async function aggregateSignals(
  freshnessWindowSec: number = 600,
): Promise<AggregatedResponse> {
  const nowSec = Math.floor(Date.now() / 1000);
  const timestampMs = Date.now();

  // Fan out all 3 signals-fetchers AND all 3 health-fetchers in parallel.
  // Health calls are independent of signals calls, so we can run them
  // concurrently to minimize total latency.
  const [r1, r2, r3, h1, h2, h3] = await Promise.all([
    fetchApp1(freshnessWindowSec, nowSec),
    fetchApp2(freshnessWindowSec, nowSec),
    fetchApp3(freshnessWindowSec, nowSec),
    HEALTH_FETCHERS.app1(),
    HEALTH_FETCHERS.app2(),
    HEALTH_FETCHERS.app3(),
  ]);

  // Merge health data into the per-app results.
  // Health-endpoint data is authoritative for the online/token state.
  const results: Record<AppId, NormalizeResult> = {
    app1: { ...r1, ...mergeHealth(r1, h1) },
    app2: { ...r2, ...mergeHealth(r2, h2) },
    app3: { ...r3, ...mergeHealth(r3, h3) },
  };

  // Build app status objects using authoritative health data.
  const apps: AppStatus[] = SOURCES.map((src) => {
    const r = results[src.id];
    // Online if signals call succeeded AND health didn't say "down".
    const online = r.health !== "down" && r.health !== "unknown";
    const freshCount = r.signals.filter((s) => s.fresh).length;
    return {
      id: src.id,
      name: src.name,
      url: src.baseUrl,
      online,
      lastChecked: timestampMs,
      signalCount: r.signals.length,
      freshSignalCount: freshCount,
      health: r.health,
      detail: r.detail,
      live: r.live,
      tokenExpired: r.tokenExpired,
      uptimeSec: r.uptimeSec,
      activeStreams: r.activeStreams,
      latencyMs: r.latencyMs,
      error: r.error,
    };
  });

  // ---- Build candle-aligned consensus ----
  // For each pair, group ALL signals by candle-time (minute-floored).
  // For each (pair, candle) we have at most one signal per app (latest wins).
  // Consensus is computed per-candle — only signals for the SAME candle
  // are compared. This is the key fix: previously we compared "latest from
  // each app" which could be from different candles, producing bogus matches.
  const pairMap = new Map<string, {
    otc: boolean;
    // candleTime -> { app -> signal }
    candles: Map<number, Partial<Record<AppId, SourceSignal>>>;
  }>();

  (["app1", "app2", "app3"] as AppId[]).forEach((id) => {
    for (const sig of results[id].signals) {
      let entry = pairMap.get(sig.pair);
      if (!entry) {
        entry = { otc: classifyPair(sig.pair) === "otc", candles: new Map() };
        pairMap.set(sig.pair, entry);
      }
      let candle = entry.candles.get(sig.candleTime);
      if (!candle) {
        candle = {};
        entry.candles.set(sig.candleTime, candle);
      }
      // Keep the latest signal per app per candle (in case of dupes)
      const cur = candle[id];
      if (!cur || sig.timestamp > cur.timestamp) {
        candle[id] = sig;
      }
    }
  });

  // Build per-pair consensus list
  const pairs: PairConsensus[] = [];
  pairMap.forEach((entry, pair) => {
    // For each candle, classify consensus
    const candleEntries: CandleConsensus[] = [];
    entry.candles.forEach((appsMap, candleTime) => {
      const sigs: SourceSignal[] = [];
      let callCount = 0, putCount = 0, neutralCount = 0, freshCount = 0;
      const agreeing: AppId[] = [];
      const disagreeing: AppId[] = [];
      const missing: AppId[] = [];

      (["app1", "app2", "app3"] as AppId[]).forEach((id) => {
        const s = appsMap[id];
        if (!s) { missing.push(id); return; }
        if (!s.fresh) { missing.push(id); return; }
        sigs.push(s);
        freshCount++;
        if (s.direction === "CALL") callCount++;
        else if (s.direction === "PUT") putCount++;
        else neutralCount++;
      });

      let level: ConsensusLevel;
      let direction: Direction | null = null;

      if (freshCount === 0) {
        level = "none";
      } else if (freshCount === 1) {
        level = "1-only";
        direction = sigs[0].direction;
        agreeing.push(sigs[0].source);
      } else {
        const dominant = (callCount >= putCount ? "CALL" : "PUT") as Direction;
        const dominantCount = dominant === "CALL" ? callCount : putCount;
        if (dominantCount === freshCount) {
          level = freshCount === 3 ? "3-agree" : "2-agree";
          direction = dominant;
          sigs.forEach((s) => {
            if (s.direction === dominant) agreeing.push(s.source);
            else disagreeing.push(s.source);
          });
        } else {
          level = "conflict";
          sigs.forEach((s) => {
            if (s.direction === dominant) agreeing.push(s.source);
            else disagreeing.push(s.source);
          });
        }
      }

      candleEntries.push({
        pair,
        displayPair: displayPairFromAsset(pair),
        category: entry.otc ? "otc" : "real",
        candleTime,
        signals: sigs.sort((a, b) => (a.source > b.source ? 1 : -1)),
        freshCount,
        callCount,
        putCount,
        neutralCount,
        consensus: {
          level,
          direction,
          agreeingApps: agreeing,
          disagreeingApps: disagreeing,
          missingApps: missing,
        },
      });
    });

    // Sort candles newest first
    candleEntries.sort((a, b) => b.candleTime - a.candleTime);

    // Pick the "latest candle" for display. We always show the NEWEST candle
    // (candleEntries[0], since sorted newest-first). The user explicitly wants
    // "if any candle data is missing, signal should be closed/none" — so we
    // don't skip back to find an agreeing candle. The newest candle's
    // consensus IS the pair's current consensus.
    let latestCandle: CandleConsensus | null = null;
    if (candleEntries.length > 0) {
      latestCandle = candleEntries[0];
    }

    // The pair's overall consensus = the latest candle's consensus.
    // The pair's signals list = the latest candle's signals (for the
    // backwards-compatible "latest signal per app" view).
    const signals = latestCandle ? latestCandle.signals : [];
    const freshCount = latestCandle ? latestCandle.freshCount : 0;
    const callCount = latestCandle ? latestCandle.callCount : 0;
    const putCount = latestCandle ? latestCandle.putCount : 0;
    const neutralCount = latestCandle ? latestCandle.neutralCount : 0;

    pairs.push({
      pair,
      displayPair: displayPairFromAsset(pair),
      category: entry.otc ? "otc" : "real",
      signals,
      candles: candleEntries,
      latestCandle,
      freshCount,
      callCount,
      putCount,
      neutralCount,
      consensus: latestCandle ? latestCandle.consensus : {
        level: "none" as ConsensusLevel,
        direction: null,
        agreeingApps: [],
        disagreeingApps: [],
        missingApps: ["app1", "app2", "app3"] as AppId[],
      },
    });
  });

  // Sort: 3-agree > 2-agree > conflict > 1-only > none; ties break by category (otc first) then displayPair
  const levelOrder: Record<ConsensusLevel, number> = {
    "3-agree": 0, "2-agree": 1, conflict: 2, "1-only": 3, none: 4,
  };
  pairs.sort((a, b) => {
    const l = levelOrder[a.consensus.level] - levelOrder[b.consensus.level];
    if (l !== 0) return l;
    if (a.category !== b.category) return a.category === "otc" ? -1 : 1;
    return a.displayPair.localeCompare(b.displayPair);
  });

  const summary: AggregatedResponse["summary"] = {
    totalPairs: pairs.length,
    threeBotAgree: pairs.filter((p) => p.consensus.level === "3-agree"),
    twoBotAgree: pairs.filter((p) => p.consensus.level === "2-agree"),
    conflicts: pairs.filter((p) => p.consensus.level === "conflict"),
    singleOnly: pairs.filter((p) => p.consensus.level === "1-only"),
    pairsByDirection: {
      CALL: pairs.filter((p) => p.consensus.direction === "CALL").length,
      PUT: pairs.filter((p) => p.consensus.direction === "PUT").length,
      NEUTRAL: pairs.filter((p) => p.consensus.direction === "NEUTRAL").length,
      NONE: pairs.filter((p) => p.consensus.direction === null).length,
    },
  };

  return {
    timestamp: timestampMs,
    freshnessWindowSec,
    apps,
    pairs,
    summary,
  };
}
