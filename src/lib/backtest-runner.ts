/**
 * Backtest Runner
 * ---------------
 * Server-side TypeScript port of /scripts/backtest.py.
 * Fetches historical signals from all 3 source apps, normalizes them,
 * clusters overlapping signals per pair (±60s window), classifies each
 * cluster by consensus level, and computes per-level win rate.
 *
 * Used by GET /api/backtest.
 */

import { fetchJsonWithTimeout } from "./backtest-fetcher";

export type AppId = "app1" | "app2" | "app3";
export type Direction = "CALL" | "PUT";
export type ConsensusLevel = "3-agree" | "2-agree" | "conflict" | "1-only";

export interface NormalizedSignal {
  source: AppId;
  pair: string;
  ts: number; // unix seconds
  direction: Direction;
  outcome: 0 | 1 | null; // 1=win, 0=loss, null=unknown
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
  app2: { name: "Binary Signal Terminal", url: "https://binary-signals-app-production.up.railway.app/api/agent/decisions?limit=500" },
  app3: { name: "OTC Live Trading", url: "https://otc-live-trading-production.up.railway.app/api/signals?limit=500" },
} as const;

// ---- Normalizers ----------------------------------------------------------

function normalizeApp1(d: any): NormalizedSignal | null {
  const pair = d?.symbol;
  if (!pair) return null;
  const tsMs = Number(d?.signalAt ?? d?.entryTime ?? 0);
  const ts = tsMs > 1e12 ? Math.floor(tsMs / 1000) : Math.floor(tsMs);
  const direction = String(d?.direction ?? "").toUpperCase();
  if (direction !== "CALL" && direction !== "PUT") return null;
  const status = d?.status;
  let outcome: 0 | 1 | null = null;
  if (status === "WIN") outcome = 1;
  else if (status === "LOSS") outcome = 0;
  else outcome = null; // DRAW / VOID / unknown
  return { source: "app1", pair, ts, direction, outcome, rawStatus: status ?? null };
}

function normalizeApp2(d: any): NormalizedSignal | null {
  const pair = d?.asset;
  if (!pair) return null;
  const ts = Math.floor(Number(d?.ts ?? 0));
  const direction = String(d?.signal ?? "").toUpperCase();
  if (direction !== "CALL" && direction !== "PUT") return null;
  return { source: "app2", pair, ts, direction, outcome: null, rawStatus: d?.verdict ?? null };
}

function normalizeApp3(d: any): NormalizedSignal | null {
  const pair = d?.asset;
  if (!pair) return null;
  const ts = Math.floor(Number(d?.ctime ?? 0));
  const direction = String(d?.signal ?? "").toUpperCase();
  if (direction !== "CALL" && direction !== "PUT") return null;
  const result = d?.result;
  let outcome: 0 | 1 | null = null;
  if (result === "correct") outcome = 1;
  else if (result === "wrong") outcome = 0;
  else outcome = null; // draw / unknown
  return { source: "app3", pair, ts, direction, outcome, rawStatus: result ?? null };
}

// ---- Cluster detection ----------------------------------------------------

function findClusters(signalsForPair: NormalizedSignal[], windowSec = 60): Cluster[] {
  const arr = signalsForPair;
  const n = arr.length;
  const clusters: Cluster[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const anchor = arr[i];
    const members: NormalizedSignal[] = [anchor];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const other = arr[j];
      if (Math.abs(other.ts - anchor.ts) <= windowSec) {
        members.push(other);
      }
    }
    const appsIn = members.map((m) => m.source).sort() as string[];
    const tsMin = Math.min(...members.map((m) => m.ts));
    const sig = `${appsIn.join(",")}|${Math.floor(tsMin / 60)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const perApp: Partial<Record<AppId, NormalizedSignal>> = {};
    for (const m of members) {
      const cur = perApp[m.source];
      if (!cur || m.ts > cur.ts) perApp[m.source] = m;
    }
    clusters.push({ tsAnchor: anchor.ts, apps: perApp, nApps: Object.keys(perApp).length });
  }
  return clusters;
}

function classifyCluster(cluster: Cluster) {
  const apps = cluster.apps;
  const n = cluster.nApps;
  const signalList = Object.values(apps).filter(Boolean) as NormalizedSignal[];
  const directions = signalList.map((a) => a.direction);
  const callC = directions.filter((d) => d === "CALL").length;
  const putC = directions.filter((d) => d === "PUT").length;

  let level: ConsensusLevel;
  let direction: Direction | null;

  if (callC === n) {
    direction = "CALL";
    level = n === 3 ? "3-agree" : n === 2 ? "2-agree" : "1-only";
  } else if (putC === n) {
    direction = "PUT";
    level = n === 3 ? "3-agree" : n === 2 ? "2-agree" : "1-only";
  } else if (callC >= 2 || putC >= 2) {
    direction = callC > putC ? "CALL" : "PUT";
    level = "conflict";
  } else {
    direction = null;
    level = "conflict";
  }

  const targetDir = direction;
  const agreeingOutcomes = signalList
    .filter((a) => a.direction === targetDir && a.outcome !== null)
    .map((a) => a.outcome as 0 | 1);

  const win = agreeingOutcomes.filter((o) => o === 1).length;
  const loss = agreeingOutcomes.filter((o) => o === 0).length;
  const unknown = signalList.filter((a) => a.direction === targetDir && a.outcome === null).length;

  let outcome: 0 | 1 | null = null;
  if (agreeingOutcomes.length === 0) outcome = null;
  else if (agreeingOutcomes.every((o) => o === 1)) outcome = 1;
  else outcome = 0;

  return {
    level, direction, nApps: n, callCount: callC, putCount: putC,
    agreeingWin: win, agreeingLoss: loss, agreeingUnknown: unknown,
    outcome, ts: cluster.tsAnchor,
  };
}

// ---- Main runner ----------------------------------------------------------

export async function runBacktest(): Promise<BacktestResult> {
  const allSignals: NormalizedSignal[] = [];

  // App1
  try {
    const d = await fetchJsonWithTimeout(SOURCES.app1.url);
    const arr: any[] = Array.isArray(d?.signals) ? d.signals : [];
    for (const s of arr) {
      const n = normalizeApp1(s);
      if (n) allSignals.push(n);
    }
  } catch { /* ignore */ }

  // App2
  try {
    const d = await fetchJsonWithTimeout(SOURCES.app2.url);
    const arr: any[] = Array.isArray(d?.decisions) ? d.decisions : [];
    for (const s of arr) {
      const n = normalizeApp2(s);
      if (n) allSignals.push(n);
    }
  } catch { /* ignore */ }

  // App3
  try {
    const d = await fetchJsonWithTimeout(SOURCES.app3.url);
    const arr: any[] = Array.isArray(d) ? d : Array.isArray(d?.signals) ? d.signals : [];
    for (const s of arr) {
      const n = normalizeApp3(s);
      if (n) allSignals.push(n);
    }
  } catch { /* ignore */ }

  // Group by pair
  const byPair = new Map<string, NormalizedSignal[]>();
  for (const s of allSignals) {
    let arr = byPair.get(s.pair);
    if (!arr) { arr = []; byPair.set(s.pair, arr); }
    arr.push(s);
  }
  byPair.forEach((arr) => arr.sort((a, b) => a.ts - b.ts));

  const allClusters: ClassifiedCluster[] = [];
  byPair.forEach((arr, pair) => {
    const clusters = findClusters(arr, 60);
    for (const c of clusters) {
      const cls = classifyCluster(c);
      allClusters.push({ ...cls, pair });
    }
  });

  // Level stats
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

  // Source stats
  const sources: Record<AppId, SourceStat> = {
    app1: { total: 0, win: 0, loss: 0, unknown: 0 },
    app2: { total: 0, win: 0, loss: 0, unknown: 0 },
    app3: { total: 0, win: 0, loss: 0, unknown: 0 },
  };
  for (const s of allSignals) {
    const st = sources[s.source];
    st.total++;
    if (s.outcome === 1) st.win++;
    else if (s.outcome === 0) st.loss++;
    else st.unknown++;
  }

  // Samples
  const sampleThreeAgree = allClusters
    .filter((c) => c.level === "3-agree")
    .slice(0, 10);
  const sampleTwoAgree = allClusters
    .filter((c) => c.level === "2-agree" && c.outcome !== null)
    .slice(0, 10);

  // Verdict
  const g3 = levels["3-agree"].win + levels["3-agree"].loss;
  const g2 = levels["2-agree"].win + levels["2-agree"].loss;
  const g1 = levels["1-only"].win + levels["1-only"].loss;
  let verdict: BacktestResult["verdict"];
  if (g3 >= 5 && g2 >= 5 && g1 >= 5) {
    const wr3 = levels["3-agree"].win / g3 * 100;
    const wr2 = levels["2-agree"].win / g2 * 100;
    const wr1 = levels["1-only"].win / g1 * 100;
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
    total: 0, win: 0, loss: 0, unknown: 0,
    call: 0, put: 0, callWin: 0, callLoss: 0, putWin: 0, putLoss: 0,
  };
}
