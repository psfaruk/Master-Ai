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
    signalsPath: "/api/signals?limit=300",
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
 * The `time` field is the candle time in HH:MM format (UTC, minute-floored).
 * We convert it to a unix-seconds timestamp using today's UTC date.
 *
 * Live updates also flow through WebSocket /ws, but for our use case polling
 * /api/share-signals every 5s is sufficient and simpler.
 */
async function fetchApp2(freshnessWindowSec: number, nowSec: number): Promise<NormalizeResult> {
  const src = SOURCES[1];
  let data: any;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`, FETCH_TIMEOUT_MS);
  } catch {
    return { signals: [], health: "down", rawCount: 0, error: "fetch_failed" };
  }
  if (!data) {
    return { signals: [], health: "down", rawCount: 0, error: "empty_response" };
  }
  const arr: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const health = data?.connected === false ? "down" : "ok";

  // The endpoint also gives a server timestamp (unix seconds, float).
  const serverTs = Number(data?.timestamp ?? 0);
  const serverSec = serverTs > 1e12 ? Math.floor(serverTs / 1000) : Math.floor(serverTs);

  const out: SourceSignal[] = [];
  for (const r of arr) {
    const pair = r?.pair;
    if (!pair) continue;
    const rawSignal = String(r?.signal ?? "").toUpperCase().trim();
    // App2 uses "—" for "no signal this candle". Treat it as NEUTRAL / skip.
    if (rawSignal !== "CALL" && rawSignal !== "PUT") continue;
    const dir = rawSignal as Direction;

    // Parse the "HH:MM" time string into a unix-seconds timestamp for today.
    // If parsing fails, fall back to the server timestamp.
    const timeStr = String(r?.time ?? "");
    let candleTime = serverSec > 0 ? Math.floor(serverSec / 60) * 60 : nowSec;
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const hh = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) {
        const now = new Date(nowSec * 1000);
        const utcY = now.getUTCFullYear();
        const utcM = now.getUTCMonth();
        const utcD = now.getUTCDate();
        const dt = Date.UTC(utcY, utcM, utcD, hh, mm, 0) / 1000;
        // If the parsed time is more than 12h in the future, it's probably
        // yesterday's candle (e.g. now is 23:50 and time says 00:10).
        let ts = dt;
        if (ts - nowSec > 12 * 3600) ts -= 24 * 3600;
        candleTime = Math.floor(ts / 60) * 60;
      }
    }

    // confidence comes as 0-100 integer; normalize to 0-1 for our schema.
    const conf100 = typeof r?.confidence === "number" ? r.confidence : 0;
    const confidence = conf100 > 0 ? conf100 / 100 : null;

    // last_update is a float (seconds) — used as the actual signal timestamp.
    const lastUpdate = Number(r?.last_update ?? 0);
    const ts = lastUpdate > 0 ? Math.floor(lastUpdate) : candleTime;
    const ageSec = Math.max(0, nowSec - ts);

    const strengthStr = typeof r?.strength === "string" ? r.strength.toUpperCase() : null;

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

  return { signals: out, health, rawCount: arr.length };
}

/** App3 (OTC Live Trading): /api/signals?limit=N -> [...] */
async function fetchApp3(freshnessWindowSec: number, nowSec: number): Promise<NormalizeResult> {
  const src = SOURCES[2];
  let data: any;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`, FETCH_TIMEOUT_MS);
  } catch {
    return { signals: [], health: "down", rawCount: 0, error: "fetch_failed" };
  }
  if (!data) {
    return { signals: [], health: "down", rawCount: 0, error: "empty_response" };
  }
  const arr: any[] = Array.isArray(data) ? data : (Array.isArray(data?.signals) ? data.signals : []);
  const health = data?.connected === false ? "down" : "ok";

  // IMPORTANT: We no longer group-by-asset-to-latest here. We keep ALL
  // signals so the aggregator can align them by candle-time across apps.
  const out: SourceSignal[] = [];
  for (const s of arr) {
    const a = s?.asset;
    if (!a) continue;
    const ts = Math.floor(Number(s.ctime ?? 0));
    const dir = String(s.signal ?? "").toUpperCase() as Direction;
    if (dir !== "CALL" && dir !== "PUT") continue;
    // App3's ctime is the candle time (the minute the signal is for).
    const candleTime = Math.floor(ts / 60) * 60;
    const ageSec = Math.max(0, nowSec - ts);
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

  return { signals: out, health, rawCount: arr.length };
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

    // Pick the "latest candle" for display:
    // Prefer the newest candle with 2+ agreeing apps; fall back to the newest
    // candle overall; if no candles, null.
    let latestCandle: CandleConsensus | null = null;
    if (candleEntries.length > 0) {
      latestCandle =
        candleEntries.find((c) => c.consensus.level === "3-agree") ??
        candleEntries.find((c) => c.consensus.level === "2-agree") ??
        candleEntries[0];
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
