/**
 * Backtest Runner
 * ---------------
 * Fetches historical signals from all 3 source apps, normalizes them,
 * aligns them by candle-time (minute-floored), classifies each candle's
 * consensus, and computes per-level AND per-pair win rate.
 *
 * Outcomes are graded against ACTUAL candle data from App 3 (see
 * ./candle-fetcher.ts). This means:
 *   - Every signal gets a win/loss verdict, even when its source app
 *     doesn't report one (notably App 2, which never reports outcomes).
 *   - The verdict is computed from (close - open) vs direction, so it is
 *     independent of the source app's own bookkeeping and is therefore
 *     consistent across all 3 apps.
 *
 * Per-pair breakdown:
 *   The `perPair` field holds per-pair per-level stats and the per-pair
 *   cluster history. The UI uses this to render a pair selector + a
 *   "show me only 2-agree signals for this pair" filter.
 *
 * Used by GET /api/backtest.
 */

import { fetchJsonWithTimeout } from "./backtest-fetcher";
import { getAllCachedApp2Signals, startApp2CachePoller } from "./app2-cache";
import {
  gradeSignal,
  refreshCandles,
  startCandlePoller,
  type Candle,
} from "./candle-fetcher";
import {
  canonicalPair,
  candleFloor,
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

export type { AppId };
export type Direction = "CALL" | "PUT";
export type ConsensusLevel = "3-agree" | "2-agree" | "conflict" | "1-only";

export interface NormalizedSignal {
  source: AppId;
  pair: string;
  ts: number; // unix seconds — when the app emitted the signal
  /** Candle time (unix seconds, minute-floored) — used for strict alignment. */
  candleTime: number;
  direction: Direction;
  /** 1=win, 0=loss, null=unknown (incl. ACTIVE / unresolved / no candle data).
   *  DRAW is represented as `null` and tracked separately via rawStatus so
   *  the backtest can EXCLUDE draws from the graded count (a draw is neither
   *  a win nor a loss — counting it as "unknown" used to dilute the win rate). */
  outcome: 0 | 1 | null;
  rawStatus?: string | null;
}

export interface Cluster {
  tsAnchor: number;
  apps: Partial<Record<AppId, NormalizedSignal>>;
  nApps: number;
}

export interface ClassifiedCluster extends ReturnType<typeof classifyCluster> {
  pair: string;
}

export interface LevelStat {
  total: number;
  win: number;
  loss: number;
  unknown: number;
  /** Resolved-but-drawn candles (excluded from win/loss/unknown). */
  draw: number;
  call: number;
  put: number;
  callWin: number;
  callLoss: number;
  putWin: number;
  putLoss: number;
}

export interface SourceStat {
  total: number;
  win: number;
  loss: number;
  unknown: number;
  draw: number;
}

/** Per-pair stats — one entry per consensus level. */
export interface PairStat {
  pair: string;
  displayPair: string;
  category: "otc" | "real";
  levels: Record<ConsensusLevel, LevelStat>;
  /** Recent clusters for this pair, newest first. */
  history: ClassifiedCluster[];
}

export interface BacktestResult {
  timestamp: number;
  totalSignals: number;
  totalClusters: number;
  levels: Record<ConsensusLevel, LevelStat>;
  sources: Record<AppId, SourceStat>;
  /** Per-pair breakdown — used by the per-pair win rate UI. */
  perPair: PairStat[];
  sampleThreeAgree: ClassifiedCluster[];
  sampleTwoAgree: ClassifiedCluster[];
  verdict:
    | { kind: "validated"; message: string }
    | { kind: "partial"; message: string }
    | { kind: "anomaly"; message: string }
    | { kind: "insufficient"; message: string; have: { three: number; two: number; one: number } };
}

const SOURCES = {
  app1: { name: "Minimum Pair", url: "https://minimum-pair-production.up.railway.app/api/signals" },
  app2: { name: "Binary Signal Terminal", url: "https://binary-signals-app-production.up.railway.app/api/share-signals" },
  app3: { name: "OTC Live Trading", url: "https://otc-live-trading-production.up.railway.app/api/signals?limit=500" },
  app3Live: { name: "OTC Live Trading", url: "https://otc-live-trading-production.up.railway.app/api/share-signals" },
} as const;

/** How far back the backtest looks. */
const LOOKBACK_SEC = 6 * 3600;

// ---- Normalizers ----------------------------------------------------------

function normalizeApp1(d: any): NormalizedSignal | null {
  const pair = canonicalPair(pickField(d, PAIR_KEYS));
  if (!pair) return null;
  const direction = parseDirection(pickField(d, DIRECTION_KEYS));
  if (!direction) return null;

  const emittedAt = toUnixSeconds(pickField(d, ["signalAt", "signal_at", "createdAt", "ts"]));
  const entrySec = toUnixSeconds(pickField(d, ["entryTime", "entry_time", "candleTime", "ctime"]));
  const base = entrySec > 0 ? entrySec : emittedAt;
  if (!(base > 0)) return null;
  const candleTime = candleFloor(base) + getCandleOffsetSec("app1");

  const status = pickField(d, ["status", "result", "outcome"]);
  const s = String(status ?? "").toUpperCase();
  let outcome: 0 | 1 | null = null;
  if (s === "WIN" || s === "CORRECT") outcome = 1;
  else if (s === "LOSS" || s === "WRONG") outcome = 0;

  return {
    source: "app1",
    pair,
    ts: emittedAt > 0 ? emittedAt : candleTime,
    candleTime,
    direction,
    outcome,
    rawStatus: status != null ? String(status) : null,
  };
}

function normalizeApp3(d: any, timeKeys: string[]): NormalizedSignal | null {
  const pair = canonicalPair(pickField(d, PAIR_KEYS));
  if (!pair) return null;
  const direction = parseDirection(pickField(d, DIRECTION_KEYS));
  if (!direction) return null;

  const ts = toUnixSeconds(pickField(d, timeKeys));
  if (!(ts > 0)) return null;
  const candleTime = candleFloor(ts) + getCandleOffsetSec("app3");

  const result = String(pickField(d, ["result", "outcome", "status"]) ?? "").toLowerCase();
  let outcome: 0 | 1 | null = null;
  if (result === "correct" || result === "win") outcome = 1;
  else if (result === "wrong" || result === "loss") outcome = 0;

  return { source: "app3", pair, ts, candleTime, direction, outcome, rawStatus: result || null };
}

// ---- Cluster classification -----------------------------------------------

function classifyCluster(cluster: Cluster) {
  const signalList = Object.values(cluster.apps).filter(Boolean) as NormalizedSignal[];
  const n = signalList.length;
  const callC = signalList.filter((a) => a.direction === "CALL").length;
  const putC = signalList.filter((a) => a.direction === "PUT").length;

  let level: ConsensusLevel;
  let direction: Direction | null;

  if (n === 1) {
    level = "1-only";
    direction = signalList[0].direction;
  } else if (callC === n) {
    direction = "CALL";
    level = n >= 3 ? "3-agree" : "2-agree";
  } else if (putC === n) {
    direction = "PUT";
    level = n >= 3 ? "3-agree" : "2-agree";
  } else {
    level = "conflict";
    direction = callC > putC ? "CALL" : putC > callC ? "PUT" : null;
  }

  // Grade only the apps that voted for the consensus direction.
  const gradable = level === "conflict" ? [] : signalList.filter((a) => a.direction === direction);
  const isNeutral = (rs: string) => {
    const v = rs.toLowerCase();
    return v === "draw" || v === "void";
  };
  const gradableNonDraw = gradable.filter((a) => !isNeutral(String(a.rawStatus ?? "")));
  const outcomes = gradableNonDraw.map((a) => a.outcome).filter((o): o is 0 | 1 => o !== null);
  const drawCount = gradable.length - gradableNonDraw.length;

  const win = outcomes.filter((o) => o === 1).length;
  const loss = outcomes.filter((o) => o === 0).length;
  const unknown = gradableNonDraw.length - outcomes.length;

  let outcome: 0 | 1 | null = null;
  if (outcomes.length > 0) outcome = outcomes.every((o) => o === 1) ? 1 : 0;

  return {
    level,
    direction,
    nApps: n,
    callCount: callC,
    putCount: putC,
    agreeingWin: win,
    agreeingLoss: loss,
    agreeingUnknown: unknown,
    agreeingDraw: drawCount,
    outcome,
    ts: cluster.tsAnchor,
  };
}

// ---- Outcome grading against candle data ----------------------------------

/**
 * Fill in missing outcomes by grading each signal against the actual candle
 * close from App 3 (via candle-fetcher).
 *
 * For signals whose source app already reports an outcome (App 1 / App 3),
 * we KEEP that outcome — it is the source-of-truth verdict.
 *
 * For signals with no outcome (App 2, or any signal whose source marked it
 * ACTIVE/null), we look up the candle by (pair, candleTime) and grade:
 *   - CALL wins if close > open
 *   - PUT  wins if close < open
 *   - DRAW if close === open (within epsilon)
 *   - UNKNOWN if candle data is missing (candle hasn't closed yet, or App 3
 *     doesn't track this pair)
 *
 * The candle data was refreshed at the top of runBacktest().
 */
function gradeWithCandles(signals: NormalizedSignal[]): void {
  for (const s of signals) {
    if (s.outcome !== null) continue; // source already reported
    if (s.rawStatus && /draw|void/i.test(s.rawStatus)) continue; // already classified

    const result = gradeSignal(s.pair, s.candleTime, s.direction);
    if (result.outcome === "WIN") {
      s.outcome = 1;
    } else if (result.outcome === "LOSS") {
      s.outcome = 0;
      // Also record rawStatus so the isNeutral() check above doesn't trip
      // on candles we ourselves graded as DRAW.
    } else if (result.outcome === "DRAW") {
      s.rawStatus = "draw";
    }
    // UNKNOWN → leave outcome null (still graded as "unknown" by the stats loop)
  }
}

// ---- Main runner ----------------------------------------------------------

export async function runBacktest(): Promise<BacktestResult> {
  // App 2 has no history endpoint — our own poller is the only source of past
  // candles, so make sure it is running even if /api/snapshot was never hit.
  startApp2CachePoller();
  // Start the candle poller too — it grades signals against actual closes.
  startCandlePoller();
  // Force one synchronous refresh so the grading below has fresh data.
  // (The background poller may have just started; this guarantees we have
  // at least one fetch in the cache before we try to grade.)
  await refreshCandles().catch(() => {});

  const allSignals: NormalizedSignal[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const minCandle = candleFloor(nowSec - LOOKBACK_SEC);

  const push = (s: NormalizedSignal | null) => {
    if (!s) return;
    if (s.candleTime < minCandle) return;
    if (!isSignalValidForCandle(s.ts, s.candleTime)) return;
    allSignals.push(s);
  };

  // App1 — historical signals with WIN/LOSS outcome
  try {
    const d = await fetchJsonWithTimeout(SOURCES.app1.url);
    for (const s of pickArray(d, ["signals", "rows", "data"])) push(normalizeApp1(s));
  } catch { /* ignore — a missing app just means fewer clusters */ }

  // App2 — historical candles recorded by our own poller.
  for (const c of getAllCachedApp2Signals()) {
    push({
      source: "app2",
      pair: c.pair,
      ts: c.firstSeenSec > 0 ? c.firstSeenSec : c.candleTime,
      candleTime: c.candleTime + getCandleOffsetSec("app2"),
      direction: c.signal,
      outcome: null, // App 2 never reports an outcome — graded via candle data below
      rawStatus: null,
    });
  }

  // App3 — resolved history (has correct/wrong) + the current live candle.
  try {
    const d = await fetchJsonWithTimeout(SOURCES.app3.url);
    for (const s of pickArray(d, ["signals", "rows", "data"])) {
      push(normalizeApp3(s, ["ctime", "candle_time", "time", "ts"]));
    }
  } catch { /* ignore */ }
  try {
    const d = await fetchJsonWithTimeout(SOURCES.app3Live.url);
    for (const s of pickArray(d, ["signals", "rows", "data"])) {
      push(normalizeApp3(s, ["time", "candle_time", "ctime", "ts"]));
    }
  } catch { /* ignore */ }

  // ---- Grade signals that lack an outcome, using candle close data ----
  gradeWithCandles(allSignals);

  // ---- Candle-aligned clustering ----
  const byPairCandle = new Map<string, Partial<Record<AppId, NormalizedSignal>>>();
  for (const s of allSignals) {
    const key = `${s.pair}|${s.candleTime}`;
    let c = byPairCandle.get(key);
    if (!c) { c = {}; byPairCandle.set(key, c); }
    const cur = c[s.source];
    if (!cur || s.ts > cur.ts) c[s.source] = s;
  }

  const allClusters: ClassifiedCluster[] = [];
  byPairCandle.forEach((appsMap, key) => {
    const sep = key.lastIndexOf("|");
    const pair = key.slice(0, sep);
    const candleTime = Number(key.slice(sep + 1));
    const cluster: Cluster = {
      tsAnchor: candleTime,
      apps: appsMap,
      nApps: Object.keys(appsMap).length,
    };
    allClusters.push({ ...classifyCluster(cluster), pair });
  });

  allClusters.sort((a, b) => b.ts - a.ts);

  // ---- Level stats (global, across all pairs) ----
  const levels: Record<ConsensusLevel, LevelStat> = {
    "3-agree": newLevelStat(),
    "2-agree": newLevelStat(),
    conflict: newLevelStat(),
    "1-only": newLevelStat(),
  };
  for (const c of allClusters) {
    addClusterToLevel(levels[c.level], c);
  }

  // ---- Per-pair stats ----
  // Group clusters by pair, then compute per-level stats per pair.
  const clustersByPair = new Map<string, ClassifiedCluster[]>();
  for (const c of allClusters) {
    let arr = clustersByPair.get(c.pair);
    if (!arr) { arr = []; clustersByPair.set(c.pair, arr); }
    arr.push(c);
  }

  const perPair: PairStat[] = [];
  clustersByPair.forEach((clusters, pair) => {
    const pl: Record<ConsensusLevel, LevelStat> = {
      "3-agree": newLevelStat(),
      "2-agree": newLevelStat(),
      conflict: newLevelStat(),
      "1-only": newLevelStat(),
    };
    for (const c of clusters) addClusterToLevel(pl[c.level], c);

    perPair.push({
      pair,
      displayPair: displayPairFromAssetLocal(pair),
      category: pair.endsWith("_otc") ? "otc" : "real",
      levels: pl,
      history: clusters,
    });
  });

  // Sort perPair so the pairs with the most clusters (most data) come first.
  perPair.sort((a, b) => {
    const aTotal = a.levels["3-agree"].total + a.levels["2-agree"].total + a.levels["1-only"].total;
    const bTotal = b.levels["3-agree"].total + b.levels["2-agree"].total + b.levels["1-only"].total;
    if (aTotal !== bTotal) return bTotal - aTotal;
    return a.displayPair.localeCompare(b.displayPair);
  });

  // Source stats — track draw separately too.
  const sources: Record<AppId, SourceStat> = {
    app1: { total: 0, win: 0, loss: 0, unknown: 0, draw: 0 },
    app2: { total: 0, win: 0, loss: 0, unknown: 0, draw: 0 },
    app3: { total: 0, win: 0, loss: 0, unknown: 0, draw: 0 },
  };
  for (const s of allSignals) {
    const st = sources[s.source];
    st.total++;
    const rs = String(s.rawStatus ?? "").toLowerCase();
    if (s.outcome === 1) st.win++;
    else if (s.outcome === 0) st.loss++;
    else if (rs === "draw" || rs === "void") st.draw++;
    else st.unknown++;
  }

  const sampleThreeAgree = allClusters.filter((c) => c.level === "3-agree").slice(0, 10);
  const sampleTwoAgree = allClusters
    .filter((c) => c.level === "2-agree" && c.outcome !== null)
    .slice(0, 10);

  // Verdict
  const g3 = levels["3-agree"].win + levels["3-agree"].loss;
  const g2 = levels["2-agree"].win + levels["2-agree"].loss;
  const g1 = levels["1-only"].win + levels["1-only"].loss;
  let verdict: BacktestResult["verdict"];
  if (g3 >= 5 && g2 >= 5 && g1 >= 5) {
    const wr3 = (levels["3-agree"].win / g3) * 100;
    const wr2 = (levels["2-agree"].win / g2) * 100;
    const wr1 = (levels["1-only"].win / g1) * 100;
    if (wr3 >= wr2 && wr2 >= wr1) {
      verdict = { kind: "validated", message: `Consensus logic confirmed: 3-agree ${wr3.toFixed(1)}% >= 2-agree ${wr2.toFixed(1)}% >= 1-only ${wr1.toFixed(1)}%` };
    } else if (wr3 >= wr1) {
      verdict = { kind: "partial", message: `Partial validation: 3-agree ${wr3.toFixed(1)}% > 1-only ${wr1.toFixed(1)}%, but 2-agree ${wr2.toFixed(1)}% anomaly` };
    } else {
      verdict = { kind: "anomaly", message: `Anomaly: 3-agree ${wr3.toFixed(1)}% does not outperform 1-only ${wr1.toFixed(1)}%` };
    }
  } else {
    verdict = {
      kind: "insufficient",
      message: `Insufficient graded data — need 5+ per level (have 3-agree=${g3}, 2-agree=${g2}, 1-only=${g1})`,
      have: { three: g3, two: g2, one: g1 },
    };
  }

  return {
    timestamp: Date.now(),
    totalSignals: allSignals.length,
    totalClusters: allClusters.length,
    levels,
    sources,
    perPair,
    sampleThreeAgree,
    sampleTwoAgree,
    verdict,
  };
}

function addClusterToLevel(s: LevelStat, c: ReturnType<typeof classifyCluster>): void {
  s.total++;
  if (c.outcome === 1) s.win++;
  else if (c.outcome === 0) s.loss++;
  else if ((c as any).agreeingDraw > 0 && c.outcome === null) s.draw += (c as any).agreeingDraw;
  else s.unknown++;
  if (c.direction === "CALL") {
    s.call++;
    if (c.outcome === 1) s.callWin++;
    else if (c.outcome === 0) s.callLoss++;
  } else if (c.direction === "PUT") {
    s.put++;
    if (c.outcome === 1) s.putWin++;
    else if (c.outcome === 0) s.putLoss++;
  }
}

function newLevelStat(): LevelStat {
  return {
    total: 0, win: 0, loss: 0, unknown: 0, draw: 0,
    call: 0, put: 0, callWin: 0, callLoss: 0, putWin: 0, putLoss: 0,
  };
}

// Local copy of displayPairFromAsset so we don't introduce a new import
// cycle through signal-aggregator → app2-cache → ... — the canonical
// implementation lives in signal-normalize.ts and is identical.
function displayPairFromAssetLocal(canonical: string): string {
  const otc = canonical.endsWith("_otc");
  const base = otc ? canonical.slice(0, -4) : canonical;
  const suffix = otc ? " OTC" : "";
  const QUOTES = ["USDT","USDC","BUSD","USD","EUR","GBP","JPY","CHF","CAD","AUD","NZD"];
  for (const q of QUOTES) {
    if (base.length > q.length && base.endsWith(q)) {
      return `${base.slice(0, base.length - q.length)}/${q}${suffix}`;
    }
  }
  if (base.length === 6) return `${base.slice(0, 3)}/${base.slice(3)}${suffix}`;
  return `${base}${suffix}`;
}

// Re-export Candle type so consumers can import it from backtest-runner.
export type { Candle };
