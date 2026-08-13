/**
 * Backtest Runner
 * ---------------
 * Fetches historical signals from all 3 source apps, normalizes them,
 * aligns them by candle-time (minute-floored), classifies each candle's
 * consensus, and computes per-level win rate.
 *
 * Normalization goes through ./signal-normalize.ts — the same helpers the live
 * aggregator uses. This matters: when the backtest parsed pairs and timestamps
 * with its own slightly different code, it clustered signals differently from
 * the dashboard, so the win rates it reported were not the win rates of the
 * signals actually being shown.
 *
 * Used by GET /api/backtest.
 */

import { fetchJsonWithTimeout } from "./backtest-fetcher";
import { getAllCachedApp2Signals, startApp2CachePoller } from "./app2-cache";
import {
  canonicalPair,
  candleFloor,
  getCandleOffsetSec,
  isSignalValidForCandle,
  parseDirection,
  pickArray,
  pickField,
  toUnixSeconds,
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
  /** 1=win, 0=loss, null=unknown (incl. ACTIVE / unresolved).
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

export interface BacktestResult {
  timestamp: number;
  totalSignals: number;
  totalClusters: number;
  levels: Record<ConsensusLevel, LevelStat>;
  sources: Record<AppId, SourceStat>;
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
  // DRAW / VOID are resolved-but-neutral outcomes. We keep outcome=null (so
  // they do NOT count toward win/loss) and surface rawStatus so the backtest's
  // stats loop can put them in the draw bucket instead of the unknown bucket.
  // VOID = Quotex cancelled the trade (rare); same treatment as DRAW.
  let outcome: 0 | 1 | null = null;
  if (s === "WIN" || s === "CORRECT") outcome = 1;
  else if (s === "LOSS" || s === "WRONG") outcome = 0;
  // DRAW, VOID, ACTIVE all leave outcome=null — DRAW/VOID tracked via rawStatus.

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
  // DRAW: resolved but neutral. outcome stays null so it doesn't count toward
  // win/loss; rawStatus="draw" lets the stats loop bucket it as draw, not unknown.
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

  // Grade only the apps that voted for the consensus direction. A conflict has
  // no tradeable direction, so it is never graded — counting the majority side
  // of a conflict as a "win" used to inflate the conflict row's win rate.
  const gradable = level === "conflict" ? [] : signalList.filter((a) => a.direction === direction);
  // DRAW/VOID outcomes are tracked SEPARATELY — they are resolved (so not
  // "unknown") but neither win nor loss. Excluding them from the win/loss/unknown
  // buckets keeps the win rate honest; counting them as "unknown" used to dilute it.
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

// ---- Main runner ----------------------------------------------------------

export async function runBacktest(): Promise<BacktestResult> {
  // App 2 has no history endpoint — our own poller is the only source of past
  // candles, so make sure it is running even if /api/snapshot was never hit.
  startApp2CachePoller();

  const allSignals: NormalizedSignal[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const minCandle = candleFloor(nowSec - LOOKBACK_SEC);

  const push = (s: NormalizedSignal | null) => {
    if (!s) return;
    if (s.candleTime < minCandle) return;
    // Same rule as the live dashboard: a signal only counts for a candle if it
    // was emitted in time for that candle.
    if (!isSignalValidForCandle(s.ts, s.candleTime)) return;
    allSignals.push(s);
  };

  // App1 — historical signals with WIN/LOSS outcome
  try {
    const d = await fetchJsonWithTimeout(SOURCES.app1.url);
    for (const s of pickArray(d, ["signals", "rows", "data"])) push(normalizeApp1(s));
  } catch { /* ignore — a missing app just means fewer clusters */ }

  // App2 — historical candles recorded by our own poller. The live snapshot
  // only ever holds the current candle, and app2-cache is already polling it
  // every 5s, so the cache IS the complete picture; reading the live endpoint
  // again here would only duplicate the newest row.
  for (const c of getAllCachedApp2Signals()) {
    push({
      source: "app2",
      pair: c.pair,
      ts: c.firstSeenSec > 0 ? c.firstSeenSec : c.candleTime,
      candleTime: c.candleTime + getCandleOffsetSec("app2"),
      direction: c.signal,
      outcome: null, // App 2 never reports an outcome
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

  // ---- Candle-aligned clustering ----
  // Group by (pair, candle); at most one signal per app per candle (latest
  // wins). Only signals for the SAME candle are ever compared.
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

  // Newest first, so the samples shown on the dashboard are the recent ones.
  allClusters.sort((a, b) => b.ts - a.ts);

  // Level stats — track draw separately from win/loss/unknown so the
  // win rate isn't diluted by resolved-but-drawn candles.
  const levels: Record<ConsensusLevel, LevelStat> = {
    "3-agree": newLevelStat(),
    "2-agree": newLevelStat(),
    conflict: newLevelStat(),
    "1-only": newLevelStat(),
  };
  for (const c of allClusters) {
    const s = levels[c.level];
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
    sampleThreeAgree,
    sampleTwoAgree,
    verdict,
  };
}

function newLevelStat(): LevelStat {
  return {
    total: 0, win: 0, loss: 0, unknown: 0, draw: 0,
    call: 0, put: 0, callWin: 0, callLoss: 0, putWin: 0, putLoss: 0,
  };
}
