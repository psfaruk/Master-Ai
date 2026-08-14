/**
 * Signal Aggregator
 * -----------------
 * Fetches call/put signals from 3 Quotex signal apps hosted on Railway,
 * normalizes them into a unified schema, and computes per-pair consensus
 * (2-bot agree / 3-bot agree / conflict / single).
 *
 * Why a server-side aggregator: all 3 source apps lack CORS headers,
 * so the browser cannot call them directly. We fan out server-side.
 *
 * Alignment rules (see ./signal-normalize.ts for the primitives):
 *   - Every pair name goes through canonicalPair() so App 1's `symbol`,
 *     App 2's `pair` and App 3's `asset` land on the SAME map key.
 *   - Every timestamp goes through toUnixSeconds() so a millisecond field
 *     can't push a candle 50,000 years into the future.
 *   - Consensus is computed per (pair, candle). A signal counts for a candle
 *     when it was emitted in time for that candle — NOT when it happens to be
 *     younger than N minutes relative to now.
 */

import { fetchJsonWithTimeout } from "./backtest-fetcher";
import {
  getApp2CachedSignalsForPair,
  getAllCachedApp2Pairs,
  startApp2CachePoller,
  normalizeApp2Row,
  recordApp2Signals,
  type CachedSignal,
} from "./app2-cache";
import {
  canonicalPair,
  candleFloor,
  classifyPair,
  displayPairFromAsset,
  getCandleOffsetSec,
  isSignalValidForCandle,
  parseDirection,
  pickArray,
  pickField,
  toUnixSeconds,
  CANDLE_SEC,
  DIRECTION_KEYS,
  PAIR_KEYS,
  type AppId,
} from "./signal-normalize";

export type Direction = "CALL" | "PUT" | "NEUTRAL";
export type { AppId };
export { displayPairFromAsset };
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
  /** Emitted in time for its own candle (used for consensus). */
  validForCandle: boolean;
  /** Recent relative to NOW (used for "is this app currently alive"). */
  fresh: boolean;
  /** True when this App 2 signal came from our historical cache, not the
   *  live snapshot — surfaced so the dashboard can explain where it came from. */
  cached?: boolean;
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
    /** Apps with no signal at all for this candle. */
    missingApps: AppId[];
    /** Apps that had a signal for this candle but emitted it too late/early. */
    invalidApps: AppId[];
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
  /** The newest actionable candle (see pickLatestCandle). */
  latestCandle: CandleConsensus | null;
  freshCount: number;
  callCount: number;
  putCount: number;
  neutralCount: number;
  consensus: CandleConsensus["consensus"];
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
  /** Rows returned by the upstream endpoint before normalization. */
  rawCount?: number;
  /** Rows dropped during normalization, by reason. */
  skipped?: { noPair: number; noDirection: number; noCandle: number };
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
    // New Minimum Pair app (FastAPI). The signal history endpoint returns a
    // bare JSON array of recent signals across ALL pairs when called without
    // ?pair=. We pull a generous limit so the candle-aligned consensus has
    // enough history to grade WIN/LOSS outcomes for past candles.
    signalsPath: "/api/history?limit=500",
    // /api/status reports Quotex connection state, active pair streams,
    // auth_mode and min_confidence — used as the authoritative health source.
    healthPath: "/api/status",
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

const FETCH_TIMEOUT_MS = 10000;

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
  skipped: { noPair: number; noDirection: number; noCandle: number };
  latencyMs?: number;
  error?: string;
}

function newSkipped() {
  return { noPair: 0, noDirection: 0, noCandle: 0 };
}

// ---- Health endpoint callers ---------------------------------------------
// These hit each source app's dedicated health/status endpoint to derive
// authoritative online state + token state.

async function fetchApp1Health(): Promise<Partial<NormalizeResult>> {
  try {
    const d = await fetchJsonWithTimeout(`${SOURCES[0].baseUrl}${SOURCES[0].healthPath}`, 6000);
    if (!d) return { error: "empty_health" };
    // New Minimum Pair app /api/status shape:
    //   { quotex_connected, error, pairs, active_pairs,
    //     min_confidence, always_signal, account_mode, auth_mode }
    const connected = d?.quotex_connected === true;
    const errMsg = typeof d?.error === "string" && d.error ? d.error : null;
    const activePairs: any[] = Array.isArray(d?.active_pairs) ? d.active_pairs : [];

    // The new app does not expose a token-expired flag directly. When it uses
    // session_token auth and is NOT connected without an explicit error
    // message, the most likely root cause is an expired/rejected session
    // token — surface that as "token_expired" so the dashboard shows the
    // amber "token expired" pill instead of a generic "disconnected".
    // If there IS an explicit error, trust the app's own message instead.
    const tokenExpired =
      !connected && d?.auth_mode === "session_token" && !errMsg;

    let health: AppStatus["health"];
    if (connected) health = "ok";
    else if (tokenExpired) health = "token_expired";
    else health = "disconnected";

    const detailParts: string[] = [];
    if (connected) detailParts.push(`live · ${activePairs.length} pairs`);
    else if (tokenExpired) detailParts.push("session token expired");
    else if (errMsg) detailParts.push(errMsg);
    else detailParts.push("connecting…");
    if (d?.auth_mode) detailParts.push(`auth=${d.auth_mode}`);

    return {
      health,
      live: connected,
      tokenExpired,
      activeStreams: activePairs.length,
      detail: detailParts.join(" · "),
    };
  } catch {
    return { error: "health_fetch_failed" };
  }
}

async function fetchApp2Health(): Promise<Partial<NormalizeResult>> {
  try {
    const d = await fetchJsonWithTimeout(`${SOURCES[1].baseUrl}${SOURCES[1].healthPath}`, 6000);
    if (!d) return { error: "empty_health" };
    const connected = d?.connected === true;
    const streams: any[] = Array.isArray(d?.streams?.active) ? d.streams.active : [];
    const health: AppStatus["health"] = connected ? "ok" : "disconnected";
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
    const d = await fetchJsonWithTimeout(`${SOURCES[2].baseUrl}${SOURCES[2].healthPath}`, 6000);
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
      detail: d?.token_source
        ? `token_source=${d.token_source}${connected ? " · connected" : " · disconnected"}`
        : undefined,
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
 * If the signals fetch failed but health succeeded, we still report the app as
 * online. If health also failed, we fall back to the signals fetch state.
 */
function mergeHealth(
  sigResult: NormalizeResult,
  healthResult: Partial<NormalizeResult> | undefined
): Partial<NormalizeResult> {
  if (!healthResult || healthResult.error) {
    if (sigResult.health === "down") {
      return { health: "down", detail: sigResult.error ?? "signals + health fetch failed" };
    }
    return {
      detail: sigResult.detail ?? "health check failed (signals OK)",
      live: sigResult.health === "ok",
      tokenExpired: sigResult.health === "token_expired",
    };
  }
  return {
    health: healthResult.health ?? sigResult.health,
    detail: healthResult.detail ?? sigResult.detail,
    live: healthResult.live,
    tokenExpired: healthResult.tokenExpired,
    uptimeSec: healthResult.uptimeSec,
    activeStreams: healthResult.activeStreams,
  };
}

/** Build a SourceSignal, filling in the derived fields consistently. */
function makeSignal(
  base: Omit<SourceSignal, "ageSec" | "fresh" | "validForCandle" | "displayPair">,
  nowSec: number,
  freshnessWindowSec: number
): SourceSignal {
  const ageSec = Math.max(0, nowSec - base.timestamp);
  return {
    ...base,
    displayPair: displayPairFromAsset(base.pair),
    ageSec,
    fresh: ageSec <= freshnessWindowSec,
    validForCandle: isSignalValidForCandle(base.timestamp, base.candleTime),
  };
}

/**
 * App1 (Minimum Pair — FastAPI edition): GET /api/history?limit=N
 *
 * Returns a BARE JSON ARRAY of recent signals across all tracked pairs. Each
 * row has this shape:
 *
 *   { id, pair, direction, created_at, entry_ts, target_close_ts,
 *     confidence, source, entry_price, close_price, result }
 *
 * Field semantics:
 *   - pair            display form ("USD/COP OTC", "EUR/USD") — canonicalPair()
 *                     collapses every spelling into one map key, same as before.
 *   - direction       "CALL" | "PUT" — parseDirection() already covers it.
 *   - entry_ts        unix SECONDS — the candle open being predicted. This is
 *                     the candle-alignment key (same role as the old App 1's
 *                     `entryTime` field, just renamed). candleFloor() + the
 *                     APP1_CANDLE_OFFSET env knob apply on top.
 *   - created_at      unix SECONDS — when the signal was emitted. The new app
 *                     emits at candle open, so created_at usually equals
 *                     entry_ts. We still prefer it for `timestamp` so ageSec
 *                     and freshness checks behave correctly. toUnixSeconds()
 *                     handles either seconds or milliseconds transparently.
 *   - confidence      0..1 float — a value of 0 means "no info", surfaced as
 *                     null so the UI shows "—" instead of "0.0%".
 *   - result          "WIN" | "LOSS" | "PENDING" — PENDING maps to outcome=null
 *                     (UI shows "pending"). The old App 1 used `status` with
 *                     WIN/LOSS/DRAW/VOID/ACTIVE — we keep those aliases too
 *                     so a future field rename doesn't blank the column.
 *   - source          strategy string (comma-separated when multiple, e.g.
 *                     "near_support,doji_reversal"). Goes straight into
 *                     `strategy`. The old App 1 used `primaryPattern`.
 *
 * The endpoint is wrapped in pickArray() which already handles a bare array,
 * an envelope (`{signals:[...]}` / `{rows:[...]}`) and any other top-level
 * array-of-objects property — so a future envelope rename upstream is a
 * no-op here.
 */
async function fetchApp1(freshnessWindowSec: number, nowSec: number): Promise<NormalizeResult> {
  const src = SOURCES[0];
  const skipped = newSkipped();
  let data: any;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`, FETCH_TIMEOUT_MS);
  } catch {
    return { signals: [], health: "down", rawCount: 0, skipped, error: "fetch_failed" };
  }
  if (!data) {
    return { signals: [], health: "down", rawCount: 0, skipped, error: "empty_response" };
  }
  // New app returns a bare JSON array. pickArray() also accepts the old
  // envelope shapes ({signals, rows, data}) for free, so a future rename
  // upstream is silently tolerated.
  const arr = pickArray(data, ["history", "signals", "rows", "data"]);
  const health: AppStatus["health"] = "ok";

  const offset = getCandleOffsetSec("app1");

  // Keep ALL signals (no latest-only grouping) so the aggregator can align
  // them by candle-time across apps.
  const out: SourceSignal[] = [];
  for (const s of arr) {
    const pair = canonicalPair(pickField(s, PAIR_KEYS));
    if (!pair) { skipped.noPair++; continue; }
    const dir = parseDirection(pickField(s, DIRECTION_KEYS));
    if (!dir) { skipped.noDirection++; continue; }

    // New app: entry_ts (seconds) is the candle being predicted.
    // Old app: entryTime (ms or s). Both pass through toUnixSeconds() so the
    // unit is normalized before bucketing — a ms value can no longer push the
    // candle ~53,000 years out.
    const entrySec = toUnixSeconds(
      pickField(s, ["entry_ts", "entryTime", "entry_time", "candleTime", "ctime"])
    );
    if (!(entrySec > 0)) { skipped.noCandle++; continue; }
    const candleTime = candleFloor(entrySec) + offset;

    // created_at (new) / signalAt / signal_at / createdAt / ts (old aliases).
    // Fall back to the candle time itself if the source omitted it — the new
    // app emits at candle open so they're usually equal anyway.
    const emittedAt = toUnixSeconds(
      pickField(s, ["created_at", "signalAt", "signal_at", "createdAt", "ts"])
    );
    const ts = emittedAt > 0 ? emittedAt : candleTime;

    const confidenceRaw = typeof s?.confidence === "number" ? s.confidence : null;
    // App 1 confidence is 0-1. A value of exactly 0 means "no confidence info"
    // (the app emits 0 when it has none) — surface as null so the UI shows "—"
    // instead of the misleading "0.0%".
    const confidence = confidenceRaw !== null && confidenceRaw > 0 ? confidenceRaw : null;

    // Outcome. The new app uses `result` (WIN/LOSS/PENDING). The old app used
    // `status` (WIN/LOSS/DRAW/VOID/ACTIVE). Read both so the column survives
    // either shape.
    //   - WIN/CORRECT → WIN
    //   - LOSS/WRONG  → LOSS
    //   - DRAW/VOID   → DRAW (resolved-but-neutral; excluded from win/loss)
    //   - PENDING/ACTIVE/null → outcome stays null (UI shows "pending")
    const rawResult = s?.result ? String(s.result) : null;
    const rawStatus = s?.status ? String(s.status) : null;
    const rawOutcome = rawResult ?? rawStatus;
    const normalizedOutcome = rawOutcome ? String(rawOutcome).toUpperCase() : null;
    let outcome: SourceSignal["outcome"] = null;
    if (normalizedOutcome === "WIN" || normalizedOutcome === "CORRECT") outcome = "WIN";
    else if (normalizedOutcome === "LOSS" || normalizedOutcome === "WRONG") outcome = "LOSS";
    else if (normalizedOutcome === "DRAW") outcome = "DRAW";
    else if (normalizedOutcome === "VOID") outcome = "DRAW"; // group with DRAW
    // PENDING / ACTIVE / null / unknown → outcome stays null

    // Strategy. New app: `source` (string, comma-separated when multi-strategy).
    // Old app: `primaryPattern`. Read both, prefer whichever is non-empty.
    const strategyRaw =
      (typeof s?.source === "string" && s.source) ||
      (typeof s?.primaryPattern === "string" && s.primaryPattern) ||
      null;

    // Strength is derived from confidence for the new app (the old app had a
    // separate `quality` field; if upstream ever adds it back, prefer it).
    const quality = Number(pickField(s, ["quality"]));
    const strengthBase = Number.isFinite(quality) && quality > 0
      ? quality
      : confidence ?? 0;
    const strength = strengthBase >= 0.7 ? "STRONG" : strengthBase >= 0.45 ? "MEDIUM" : "WEAK";

    out.push(
      makeSignal(
        {
          source: "app1",
          sourceName: src.name,
          pair,
          direction: dir,
          confidence,
          strength,
          timestamp: ts,
          candleTime,
          outcome,
          strategy: strategyRaw,
          reasons: Array.isArray(s?.reasons) ? s.reasons : null,
        },
        nowSec,
        freshnessWindowSec
      )
    );
  }

  return { signals: out, health, rawCount: arr.length, skipped };
}

/** Turn an app2-cache entry into a SourceSignal. */
function app2CachedToSignal(
  c: CachedSignal,
  srcName: string,
  nowSec: number,
  freshnessWindowSec: number,
  offset: number
): SourceSignal {
  const candleTime = c.candleTime + offset;
  return makeSignal(
    {
      source: "app2",
      sourceName: srcName,
      pair: c.pair,
      direction: c.signal,
      confidence: c.confidence,
      strength: c.strength,
      // App 2 generates its prediction at the open of the candle it predicts,
      // so the candle's open time IS the emission time. (Its `last_update`
      // field is an age in seconds, not a timestamp — see app2-cache.ts.)
      timestamp: c.firstSeenSec > 0 ? c.firstSeenSec : candleTime,
      candleTime,
      outcome: null,
      // App 2 currently emits buyer_pct/seller_pct as null for every row.
      // Only surface them when they are real numbers — otherwise the strategy
      // field used to render the misleading "buyers=null% sellers=null%".
      strategy:
        c.buyerPct != null && c.sellerPct != null && Number.isFinite(c.buyerPct) && Number.isFinite(c.sellerPct)
          ? `buyers=${c.buyerPct}% sellers=${c.sellerPct}%`
          : c.strength != null
            ? c.strength
            : null,
      reasons: c.lastTickAgeSec != null && c.lastTickAgeSec > 120
        ? [`App 2 stream stale — last tick ${Math.round(c.lastTickAgeSec)}s ago`]
        : null,
      cached: true,
    },
    nowSec,
    freshnessWindowSec
  );
}

/**
 * App2 (Binary Signal Terminal): /api/share-signals -> { rows: [...] }
 *
 * The endpoint returns a SNAPSHOT of all pairs with their CURRENT candle's
 * signal only — once a new candle starts the previous one is gone. So we merge
 * two sources: the live snapshot (authoritative for the current candle) and
 * our own historical cache (app2-cache.ts), which has been recording each
 * candle's signal every 5s.
 *
 * Both paths now parse rows through the SAME normalizeApp2Row(), so a row can
 * no longer land in one candle bucket via the snapshot and a different one via
 * the cache — which used to make App 2 look absent from the consensus.
 */
async function fetchApp2(freshnessWindowSec: number, nowSec: number): Promise<NormalizeResult> {
  // Ensure the App 2 cache poller is running (idempotent).
  startApp2CachePoller();

  const src = SOURCES[1];
  const offset = getCandleOffsetSec("app2");
  const skipped = newSkipped();

  let data: any;
  let fetchFailed = false;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`, FETCH_TIMEOUT_MS);
    // A null body means non-2xx / empty / non-JSON. That is a failure, not an
    // empty signal list — reporting it as "ok" hid genuine App 2 outages.
    if (data == null) fetchFailed = true;
  } catch {
    fetchFailed = true;
  }

  const arr = fetchFailed ? [] : pickArray(data, ["rows", "signals", "data", "items"]);
  const serverSec = toUnixSeconds(data?.timestamp ?? data?.ts ?? data?.server_time);
  const refSec = serverSec > 0 && Math.abs(serverSec - nowSec) <= 300 ? serverSec : nowSec;

  const out: SourceSignal[] = [];
  const seenCandles = new Set<string>(); // pair|candleTime

  // 1. Live snapshot — authoritative for the current candle.
  const liveEntries: CachedSignal[] = [];
  for (const row of arr) {
    const entry = normalizeApp2Row(row, refSec);
    if (!entry) {
      if (!canonicalPair(pickField(row, PAIR_KEYS))) skipped.noPair++;
      else skipped.noDirection++;
      continue;
    }
    liveEntries.push(entry);
    const sig = app2CachedToSignal(entry, src.name, nowSec, freshnessWindowSec, offset);
    sig.cached = false;
    seenCandles.add(`${sig.pair}|${sig.candleTime}`);
    out.push(sig);
  }
  // Feed the history cache from here too, so App 2's past candles survive even
  // if the background poller isn't running in this process.
  if (liveEntries.length > 0) recordApp2Signals(liveEntries);

  // 2. Historical cache — every candle the snapshot no longer shows. We take
  //    the union of pairs seen live and pairs ever cached, so a pair that is
  //    currently NEUTRAL still contributes its earlier candles.
  const allPairs = new Set<string>(out.map((s) => s.pair));
  for (const p of getAllCachedApp2Pairs()) allPairs.add(p);

  for (const pair of allPairs) {
    for (const c of getApp2CachedSignalsForPair(pair)) {
      const sig = app2CachedToSignal(c, src.name, nowSec, freshnessWindowSec, offset);
      const key = `${sig.pair}|${sig.candleTime}`;
      if (seenCandles.has(key)) continue; // live snapshot wins
      seenCandles.add(key);
      out.push(sig);
    }
  }

  const health: AppStatus["health"] = fetchFailed
    ? out.length > 0 ? "disconnected" : "down"
    : data?.connected === false ? "disconnected" : "ok";

  return {
    signals: out,
    health,
    rawCount: arr.length,
    skipped,
    error: fetchFailed ? "fetch_failed" : undefined,
    detail: fetchFailed && out.length > 0 ? "live snapshot failed — serving cached candles" : undefined,
  };
}

/**
 * App3 (OTC Live Trading): /api/share-signals (current) + /api/signals?limit=N
 *
 *   1. /api/share-signals — the CURRENT candle's live signal per pair.
 *   2. /api/signals?limit=N — RESOLVED historical signals (candle closed,
 *      result known: correct/wrong/draw).
 *
 * We need both: the live signal so consensus can align with App 1 / App 2 on
 * the candle in play, plus history for the win-rate panel. They are merged and
 * deduped by (pair, candleTime); the historical row wins because it carries a
 * resolved outcome.
 */
async function fetchApp3(freshnessWindowSec: number, nowSec: number): Promise<NormalizeResult> {
  const src = SOURCES[2];
  const offset = getCandleOffsetSec("app3");
  const skipped = newSkipped();
  const out: SourceSignal[] = [];
  const seenCandles = new Set<string>(); // pair|candleTime
  let health: AppStatus["health"] = "ok";
  let rawCount = 0;
  let histOk = false;
  let liveOk = false;

  // --- 1. RESOLVED historical signals (these carry WIN/LOSS outcomes) ---
  const histUrl = `${src.baseUrl}${(src as any).historicalPath ?? "/api/signals?limit=300"}`;
  try {
    const histData = await fetchJsonWithTimeout(histUrl, FETCH_TIMEOUT_MS);
    if (histData) {
      histOk = true;
      const arr = pickArray(histData, ["signals", "rows", "data"]);
      rawCount = arr.length;
      for (const s of arr) {
        const pair = canonicalPair(pickField(s, PAIR_KEYS));
        if (!pair) { skipped.noPair++; continue; }
        const dir = parseDirection(pickField(s, DIRECTION_KEYS));
        if (!dir) { skipped.noDirection++; continue; }
        // NOTE: ctime used to be read with a bare Math.floor(Number(...)), so
        // a millisecond value would put the candle ~53,000 years out — which
        // both hid the signal and made that bogus bucket the pair's "newest
        // candle". toUnixSeconds() normalizes the unit first.
        const ctime = toUnixSeconds(pickField(s, ["ctime", "candle_time", "time", "ts"]));
        if (!(ctime > 0)) { skipped.noCandle++; continue; }
        const candleTime = candleFloor(ctime) + offset;
        // App 3 historical: ctime is the candle time in SECONDS.
        // App 3 emits confidence in 0-1, but a value of exactly 0 means
        // "no confidence info" — surface as null so the UI shows "—".
        const histConfRaw = typeof s?.confidence === "number" ? s.confidence : null;
        const histConf = histConfRaw !== null && histConfRaw > 0 ? histConfRaw : null;
        const result = String(pickField(s, ["result", "outcome", "status"]) ?? "").toLowerCase();
        const key = `${pair}|${candleTime}`;
        seenCandles.add(key);
        out.push(
          makeSignal(
            {
              source: "app3",
              sourceName: src.name,
              pair,
              direction: dir,
              confidence: histConf,
              strength: typeof s?.strength === "string" ? s.strength : null,
              timestamp: ctime,
              candleTime,
              outcome:
                result === "correct" || result === "win"
                  ? "CORRECT"
                  : result === "wrong" || result === "loss"
                  ? "WRONG"
                  : result === "draw"
                  ? "DRAW"
                  : null,
              strategy: typeof s?.codes === "string" && s.codes ? s.codes : null,
              reasons: null,
            },
            nowSec,
            freshnessWindowSec
          )
        );
      }
    }
  } catch {
    // Historical fetch failed — keep going, we still want the live signals.
  }

  // --- 2. CURRENT live signals from /api/share-signals ---
  try {
    const liveData = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`, FETCH_TIMEOUT_MS);
    if (liveData) {
      liveOk = true;
      const liveArr = pickArray(liveData, ["signals", "rows", "data"]);
      for (const r of liveArr) {
        const pair = canonicalPair(pickField(r, PAIR_KEYS));
        if (!pair) { skipped.noPair++; continue; }
        const dir = parseDirection(pickField(r, DIRECTION_KEYS));
        if (!dir) { skipped.noDirection++; continue; }
        // App 3's share-signals `time` is a unix timestamp for the candle
        // being predicted (unit-normalized, same reasoning as ctime above).
        const t = toUnixSeconds(pickField(r, ["time", "candle_time", "ctime", "ts"]));
        const candleTime = (t > 0 ? candleFloor(t) : candleFloor(nowSec)) + offset;
        const key = `${pair}|${candleTime}`;
        if (seenCandles.has(key)) continue; // historical already has this candle
        seenCandles.add(key);
        // App 3 live: time is the unix-seconds timestamp of the candle being
        // predicted. Confidence is 0-1, but 0.0 means "no info" — surface as null.
        const liveConfRaw = typeof r?.confidence === "number" ? r.confidence : null;
        const liveConf = liveConfRaw !== null && liveConfRaw > 0 ? liveConfRaw : null;
        // prediction_candle (OHLC) — enrich the strategy field with the close
        // price so the dashboard can show what the prediction was armed against.
        const pc = r?.prediction_candle;
        const pcClose = typeof pc?.close === "number" ? pc.close : null;
        const strategy = pcClose != null
          ? `entry≈${pcClose}`
          : (typeof r?.strength === "string" ? r.strength : null);
        out.push(
          makeSignal(
            {
              source: "app3",
              sourceName: src.name,
              pair,
              direction: dir,
              confidence: liveConf,
              strength: typeof r?.strength === "string" ? r.strength : null,
              timestamp: t > 0 ? t : candleTime,
              candleTime,
              outcome: null, // live signal, not yet resolved
              strategy,
              reasons: null,
            },
            nowSec,
            freshnessWindowSec
          )
        );
      }
    }
  } catch {
    // fall through to the health decision below
  }

  let error: string | undefined;
  if (!histOk && !liveOk) {
    health = "down";
    error = "fetch_failed";
  } else if (!liveOk) {
    // The live endpoint is what feeds the current candle — say so rather than
    // silently reporting "ok" while the current candle column stays empty.
    health = "disconnected";
    error = "live_fetch_failed";
  }

  return { signals: out, health, rawCount, skipped, error };
}

// ---- Consensus ----------------------------------------------------------

/**
 * Classify one candle's per-app signals.
 *
 * Only signals that are valid FOR THAT CANDLE vote. Apps are reported in three
 * buckets so the dashboard can tell "app never sent anything" apart from "app
 * sent something too late to count".
 */
function classifyCandle(
  pair: string,
  candleTime: number,
  category: "otc" | "real",
  appsMap: Partial<Record<AppId, SourceSignal>>
): CandleConsensus {
  const sigs: SourceSignal[] = [];
  const missing: AppId[] = [];
  const invalid: AppId[] = [];

  (["app1", "app2", "app3"] as AppId[]).forEach((id) => {
    const s = appsMap[id];
    if (!s) { missing.push(id); return; }
    if (!s.validForCandle) { invalid.push(id); return; }
    sigs.push(s);
  });

  const callCount = sigs.filter((s) => s.direction === "CALL").length;
  const putCount = sigs.filter((s) => s.direction === "PUT").length;
  const neutralCount = sigs.filter((s) => s.direction === "NEUTRAL").length;
  // Only CALL/PUT are votes — a NEUTRAL row must not be able to turn an
  // all-neutral candle into a "conflict", which the old `callCount >= putCount`
  // shortcut did (it defaulted to CALL even when both counts were zero).
  const voteCount = callCount + putCount;

  const agreeing: AppId[] = [];
  const disagreeing: AppId[] = [];
  let level: ConsensusLevel;
  let direction: Direction | null = null;

  if (voteCount === 0) {
    level = "none";
  } else if (voteCount === 1) {
    level = "1-only";
    const only = sigs.find((s) => s.direction === "CALL" || s.direction === "PUT")!;
    direction = only.direction;
    agreeing.push(only.source);
  } else if (callCount === voteCount || putCount === voteCount) {
    // Unanimous among the apps that voted.
    direction = callCount === voteCount ? "CALL" : "PUT";
    level = voteCount >= 3 ? "3-agree" : "2-agree";
    sigs.forEach((s) => {
      if (s.direction === direction) agreeing.push(s.source);
    });
  } else {
    level = "conflict";
    // Majority side (null on a tie) — reported for context only; a conflict is
    // never a tradeable signal.
    direction = callCount > putCount ? "CALL" : putCount > callCount ? "PUT" : null;
    sigs.forEach((s) => {
      if (s.direction === "NEUTRAL") return;
      if (direction && s.direction === direction) agreeing.push(s.source);
      else disagreeing.push(s.source);
    });
  }

  return {
    pair,
    displayPair: displayPairFromAsset(pair),
    category,
    candleTime,
    signals: sigs.sort((a, b) => (a.source > b.source ? 1 : -1)),
    freshCount: sigs.length,
    callCount,
    putCount,
    neutralCount,
    consensus: {
      level,
      direction,
      agreeingApps: agreeing,
      disagreeingApps: disagreeing,
      missingApps: missing,
      invalidApps: invalid,
    },
  };
}

/**
 * Pick the candle the dashboard should show as "now".
 *
 * `candles` is sorted newest first. We take the newest candle that isn't
 * further ahead than one candle from the current minute: apps legitimately
 * publish a signal for the NEXT candle, but anything beyond that is a bad
 * timestamp, and letting such a bucket win used to blank out the whole row.
 */
function pickLatestCandle(candles: CandleConsensus[], nowSec: number): CandleConsensus | null {
  if (candles.length === 0) return null;
  const maxCandle = candleFloor(nowSec) + CANDLE_SEC;
  for (const c of candles) {
    if (c.candleTime <= maxCandle) return c;
  }
  return candles[candles.length - 1];
}

// ---- Aggregator entrypoint ----------------------------------------------

export async function aggregateSignals(
  freshnessWindowSec: number = 600
): Promise<AggregatedResponse> {
  const nowSec = Math.floor(Date.now() / 1000);
  const timestampMs = Date.now();

  // Fan out all 3 signals-fetchers AND all 3 health-fetchers in parallel.
  const [r1, r2, r3, h1, h2, h3] = await Promise.all([
    fetchApp1(freshnessWindowSec, nowSec),
    fetchApp2(freshnessWindowSec, nowSec),
    fetchApp3(freshnessWindowSec, nowSec),
    HEALTH_FETCHERS.app1(),
    HEALTH_FETCHERS.app2(),
    HEALTH_FETCHERS.app3(),
  ]);

  const results: Record<AppId, NormalizeResult> = {
    app1: { ...r1, ...mergeHealth(r1, h1) },
    app2: { ...r2, ...mergeHealth(r2, h2) },
    app3: { ...r3, ...mergeHealth(r3, h3) },
  };

  const apps: AppStatus[] = SOURCES.map((src) => {
    const r = results[src.id];
    const online = r.health !== "down" && r.health !== "unknown";
    return {
      id: src.id,
      name: src.name,
      url: src.baseUrl,
      online,
      lastChecked: timestampMs,
      signalCount: r.signals.length,
      freshSignalCount: r.signals.filter((s) => s.fresh).length,
      health: r.health,
      detail: r.detail,
      live: r.live,
      tokenExpired: r.tokenExpired,
      uptimeSec: r.uptimeSec,
      activeStreams: r.activeStreams,
      latencyMs: r.latencyMs,
      rawCount: r.rawCount,
      skipped: r.skipped,
      error: r.error,
    };
  });

  // ---- Build candle-aligned consensus ----
  // For each pair, group ALL signals by candle-time (minute-floored). Within a
  // (pair, candle) there is at most one signal per app. Consensus compares
  // only signals for the SAME candle.
  const pairMap = new Map<
    string,
    { otc: boolean; candles: Map<number, Partial<Record<AppId, SourceSignal>>> }
  >();

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
      const cur = candle[id];
      // Prefer a signal that's actually valid for this candle; break ties on
      // recency. (Previously a late duplicate could evict the valid one.)
      if (
        !cur ||
        (sig.validForCandle && !cur.validForCandle) ||
        (sig.validForCandle === cur.validForCandle && sig.timestamp > cur.timestamp)
      ) {
        candle[id] = sig;
      }
    }
  });

  const pairs: PairConsensus[] = [];
  pairMap.forEach((entry, pair) => {
    const category = entry.otc ? "otc" : "real";
    const candleEntries: CandleConsensus[] = [];
    entry.candles.forEach((appsMap, candleTime) => {
      candleEntries.push(classifyCandle(pair, candleTime, category, appsMap));
    });

    candleEntries.sort((a, b) => b.candleTime - a.candleTime);

    const latestCandle = pickLatestCandle(candleEntries, nowSec);

    pairs.push({
      pair,
      displayPair: displayPairFromAsset(pair),
      category,
      signals: latestCandle ? latestCandle.signals : [],
      candles: candleEntries,
      latestCandle,
      freshCount: latestCandle ? latestCandle.freshCount : 0,
      callCount: latestCandle ? latestCandle.callCount : 0,
      putCount: latestCandle ? latestCandle.putCount : 0,
      neutralCount: latestCandle ? latestCandle.neutralCount : 0,
      consensus: latestCandle
        ? latestCandle.consensus
        : {
            level: "none" as ConsensusLevel,
            direction: null,
            agreeingApps: [],
            disagreeingApps: [],
            missingApps: ["app1", "app2", "app3"] as AppId[],
            invalidApps: [],
          },
    });
  });

  // Sort: 3-agree > 2-agree > conflict > 1-only > none; ties break by category
  // (otc first) then displayPair.
  const levelOrder: Record<ConsensusLevel, number> = {
    "3-agree": 0,
    "2-agree": 1,
    conflict: 2,
    "1-only": 3,
    none: 4,
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

/**
 * Aggregation plus the per-app raw signal lists, for /api/diag. Kept separate
 * so the hot path doesn't ship the raw arrays to every dashboard poll.
 */
export async function aggregateWithRaw(freshnessWindowSec: number = 1800) {
  const nowSec = Math.floor(Date.now() / 1000);
  const [r1, r2, r3] = await Promise.all([
    fetchApp1(freshnessWindowSec, nowSec),
    fetchApp2(freshnessWindowSec, nowSec),
    fetchApp3(freshnessWindowSec, nowSec),
  ]);
  return { nowSec, perApp: { app1: r1, app2: r2, app3: r3 } };
}
