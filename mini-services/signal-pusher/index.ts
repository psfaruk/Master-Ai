/**
 * Signal Pusher Mini-Service
 * --------------------------
 * A standalone Socket.IO server that:
 *   1. Every PUSH_INTERVAL_MS (default 5000ms) fans out to the 3 source apps,
 *      fetches fresh signals + health, and computes consensus.
 *   2. Pushes the aggregated snapshot to all connected clients via the
 *      "snapshot" event.
 *   3. Sends "health" events whenever any app's health state changes.
 *
 * This offloads the polling from the browser (which would otherwise hit
 * the Next.js API every 15s) and gives true real-time updates.
 *
 * Port: 3003 (configured in Caddyfile via XTransformPort)
 */

import { createServer } from "http";
import { Server } from "socket.io";

// ---------------------------------------------------------------------------
// Types (mirror of src/lib/signal-aggregator.ts — kept inline so the
// mini-service is fully self-contained and has no Next.js imports).
// ---------------------------------------------------------------------------

type Direction = "CALL" | "PUT" | "NEUTRAL";
type AppId = "app1" | "app2" | "app3";
type ConsensusLevel = "3-agree" | "2-agree" | "conflict" | "1-only" | "none";
type HealthState = "ok" | "token_expired" | "disconnected" | "down" | "unknown";

interface SourceSignal {
  source: AppId;
  sourceName: string;
  pair: string;
  displayPair: string;
  direction: Direction;
  confidence: number | null;
  strength?: string | null;
  timestamp: number;
  /** Candle time (unix seconds, minute-floored) — used to align signals across apps. */
  candleTime: number;
  ageSec: number;
  outcome?: "WIN" | "LOSS" | "DRAW" | "CORRECT" | "WRONG" | null;
  strategy?: string | null;
  reasons?: string[] | null;
  fresh: boolean;
}

interface CandleConsensus {
  pair: string;
  displayPair: string;
  category: "otc" | "real";
  candleTime: number;
  signals: SourceSignal[];
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

interface PairConsensus {
  pair: string;
  displayPair: string;
  category: "otc" | "real";
  signals: SourceSignal[];
  candles: CandleConsensus[];
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

interface AppStatus {
  id: AppId;
  name: string;
  url: string;
  online: boolean;
  lastChecked: number;
  signalCount: number;
  freshSignalCount: number;
  health: HealthState;
  detail?: string;
  live?: boolean;
  tokenExpired?: boolean;
  latencyMs?: number;
  uptimeSec?: number;
  activeStreams?: number;
  error?: string;
}

interface AggregatedResponse {
  timestamp: number;
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

// ---------------------------------------------------------------------------
// Source app definitions
// ---------------------------------------------------------------------------

const SOURCES = [
  {
    id: "app1" as const,
    name: "Minimum Pair",
    baseUrl: "https://minimum-pair-production.up.railway.app",
    signalsPath: "/api/signals",
    healthPath: "/api/health",
  },
  {
    id: "app2" as const,
    name: "Binary Signal Terminal",
    baseUrl: "https://binary-signals-app-production.up.railway.app",
    signalsPath: "/api/share-signals",
    healthPath: "/api/status",
  },
  {
    id: "app3" as const,
    name: "OTC Live Trading",
    baseUrl: "https://otc-live-trading-production.up.railway.app",
    signalsPath: "/api/signals?limit=300",
    healthPath: "/api/token-status",
  },
] as const;

const FRESHNESS_WINDOW_SEC = 1800; // 30 min — matches Next.js route default
const PUSH_INTERVAL_MS = 5000; // push every 5s
const FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchJsonWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "qx-pusher/1.0" },
      cache: "no-store",
    });
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  } finally {
    clearTimeout(t);
  }
}

function displayPairFromAsset(asset: string): string {
  if (asset.endsWith("_otc")) {
    const base = asset.replace("_otc", "");
    return `${base.slice(0, 3)}/${base.slice(3)} OTC`;
  }
  return `${asset.slice(0, 3)}/${asset.slice(3)}`;
}

function classifyPair(asset: string): "otc" | "real" {
  return asset.endsWith("_otc") ? "otc" : "real";
}

// ---------------------------------------------------------------------------
// Health fetchers (one per source app)
// ---------------------------------------------------------------------------

async function fetchApp1Health(): Promise<Partial<{ health: HealthState; live: boolean; tokenExpired: boolean; detail?: string; uptimeSec?: number; error?: string }>> {
  try {
    const d = await fetchJsonWithTimeout(`${SOURCES[0].baseUrl}${SOURCES[0].healthPath}`, 6000);
    if (!d) return { error: "empty_health" };
    const st = d?.status ?? {};
    const tokenExpired = st?.tokenExpired === true || st?.state === "token_expired";
    const live = st?.live === true;
    let health: HealthState;
    if (tokenExpired) health = "token_expired";
    else if (!live) health = "disconnected";
    else health = "ok";
    return {
      health, live, tokenExpired,
      detail: st?.detail,
      uptimeSec: typeof st?.uptimeSec === "number" ? st.uptimeSec : undefined,
    };
  } catch {
    return { error: "health_fetch_failed" };
  }
}

async function fetchApp2Health(): Promise<Partial<{ health: HealthState; live: boolean; tokenExpired: boolean; detail?: string; activeStreams?: number; error?: string }>> {
  try {
    const d = await fetchJsonWithTimeout(`${SOURCES[1].baseUrl}${SOURCES[1].healthPath}`, 6000);
    if (!d) return { error: "empty_health" };
    const connected = d?.connected === true;
    const streams: any[] = Array.isArray(d?.streams?.active) ? d.streams.active : [];
    let health: HealthState;
    if (!connected) health = "disconnected";
    else health = "ok";
    return {
      health, live: connected, tokenExpired: false,
      activeStreams: streams.length,
      detail: connected ? `connected · ${streams.length} streams` : "disconnected",
    };
  } catch {
    return { error: "health_fetch_failed" };
  }
}

async function fetchApp3Health(): Promise<Partial<{ health: HealthState; live: boolean; tokenExpired: boolean; detail?: string; error?: string }>> {
  try {
    const d = await fetchJsonWithTimeout(`${SOURCES[2].baseUrl}${SOURCES[2].healthPath}`, 6000);
    if (!d) return { error: "empty_health" };
    const connected = d?.connected === true;
    const hasToken = d?.has_env_token === true || d?.has_user_token === true;
    let health: HealthState;
    if (!hasToken) health = "token_expired";
    else if (!connected) health = "disconnected";
    else health = "ok";
    return {
      health, live: connected, tokenExpired: !hasToken,
      detail: d?.token_source ? `token_source=${d.token_source}${connected ? " · connected" : " · disconnected"}` : undefined,
    };
  } catch {
    return { error: "health_fetch_failed" };
  }
}

// ---------------------------------------------------------------------------
// Signal fetchers + normalizers (one per source app)
// ---------------------------------------------------------------------------

async function fetchApp1Signals(nowSec: number): Promise<{ signals: SourceSignal[]; rawCount: number; error?: string }> {
  const src = SOURCES[0];
  let data: any;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`);
  } catch {
    return { signals: [], rawCount: 0, error: "fetch_failed" };
  }
  if (!data) return { signals: [], rawCount: 0, error: "empty" };
  const arr: any[] = Array.isArray(data?.signals) ? data.signals : [];
  // Keep ALL signals (no latest-only grouping) so the aggregator can align
  // them by candle-time across apps.
  const out: SourceSignal[] = [];
  for (const s of arr) {
    const sym = s?.symbol;
    if (!sym) continue;
    const tsMs = Number(s.signalAt ?? s.entryTime ?? 0);
    const ts = tsMs > 1e12 ? Math.floor(tsMs / 1000) : Math.floor(tsMs);
    const dir = String(s.direction ?? "").toUpperCase() as Direction;
    if (dir !== "CALL" && dir !== "PUT") continue;
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
      fresh: ageSec <= FRESHNESS_WINDOW_SEC,
    });
  }
  return { signals: out, rawCount: arr.length };
}

async function fetchApp2Signals(nowSec: number): Promise<{ signals: SourceSignal[]; rawCount: number; error?: string }> {
  const src = SOURCES[1];
  let data: any;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`);
  } catch {
    return { signals: [], rawCount: 0, error: "fetch_failed" };
  }
  if (!data) return { signals: [], rawCount: 0, error: "empty" };
  const arr: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const serverTs = Number(data?.timestamp ?? 0);
  const serverSec = serverTs > 1e12 ? Math.floor(serverTs / 1000) : Math.floor(serverTs);

  const out: SourceSignal[] = [];
  for (const r of arr) {
    const pair = r?.pair;
    if (!pair) continue;
    const rawSignal = String(r?.signal ?? "").toUpperCase().trim();
    if (rawSignal !== "CALL" && rawSignal !== "PUT") continue;
    const dir = rawSignal as Direction;

    // Parse "HH:MM" into unix-seconds candleTime for today (UTC).
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
      fresh: ageSec <= FRESHNESS_WINDOW_SEC,
    });
  }
  return { signals: out, rawCount: arr.length };
}

async function fetchApp3Signals(nowSec: number): Promise<{ signals: SourceSignal[]; rawCount: number; error?: string }> {
  const src = SOURCES[2];
  let data: any;
  try {
    data = await fetchJsonWithTimeout(`${src.baseUrl}${src.signalsPath}`);
  } catch {
    return { signals: [], rawCount: 0, error: "fetch_failed" };
  }
  if (!data) return { signals: [], rawCount: 0, error: "empty" };
  const arr: any[] = Array.isArray(data) ? data : Array.isArray(data?.signals) ? data.signals : [];
  // Keep ALL signals (no latest-only grouping) so the aggregator can align
  // them by candle-time across apps.
  const out: SourceSignal[] = [];
  for (const s of arr) {
    const asset = s?.asset;
    if (!asset) continue;
    const ts = Math.floor(Number(s.ctime ?? 0));
    const dir = String(s.signal ?? "").toUpperCase() as Direction;
    if (dir !== "CALL" && dir !== "PUT") continue;
    const candleTime = Math.floor(ts / 60) * 60;
    const ageSec = Math.max(0, nowSec - ts);
    out.push({
      source: "app3",
      sourceName: src.name,
      pair: asset,
      displayPair: displayPairFromAsset(asset),
      direction: dir,
      confidence: typeof s.confidence === "number" ? s.confidence : null,
      strength: typeof s.strength === "string" ? s.strength : null,
      timestamp: ts,
      candleTime,
      ageSec,
      outcome: s.result === "correct" ? "CORRECT" : s.result === "wrong" ? "WRONG" : s.result === "draw" ? "DRAW" : null,
      strategy: typeof s.codes === "string" && s.codes ? s.codes : null,
      reasons: null,
      fresh: ageSec <= FRESHNESS_WINDOW_SEC,
    });
  }
  return { signals: out, rawCount: arr.length };
}

// ---------------------------------------------------------------------------
// Aggregator (mirrors src/lib/signal-aggregator.ts)
// ---------------------------------------------------------------------------

async function aggregate(): Promise<AggregatedResponse> {
  const nowSec = Math.floor(Date.now() / 1000);
  const timestampMs = Date.now();

  const [s1, s2, s3, h1, h2, h3] = await Promise.all([
    fetchApp1Signals(nowSec),
    fetchApp2Signals(nowSec),
    fetchApp3Signals(nowSec),
    fetchApp1Health(),
    fetchApp2Health(),
    fetchApp3Health(),
  ]);

  const sigResults: Record<AppId, { signals: SourceSignal[]; rawCount: number; error?: string }> = {
    app1: s1, app2: s2, app3: s3,
  };
  const healthResults: Record<AppId, any> = { app1: h1, app2: h2, app3: h3 };

  const apps: AppStatus[] = SOURCES.map((src) => {
    const sr = sigResults[src.id];
    const hr = healthResults[src.id];
    let health: HealthState = "ok";
    let detail: string | undefined;
    let live: boolean | undefined;
    let tokenExpired: boolean | undefined;
    let uptimeSec: number | undefined;
    let activeStreams: number | undefined;

    if (hr?.error) {
      // Health fetch failed
      if (sr.error) {
        health = "down";
        detail = sr.error;
      } else {
        health = "ok";
        detail = "health check failed (signals OK)";
        live = true;
        tokenExpired = false;
      }
    } else if (hr) {
      health = hr.health ?? "ok";
      detail = hr.detail;
      live = hr.live;
      tokenExpired = hr.tokenExpired;
      uptimeSec = hr.uptimeSec;
      activeStreams = hr.activeStreams;
    } else {
      health = "unknown";
    }

    const online = health !== "down" && health !== "unknown";
    const freshCount = sr.signals.filter((s) => s.fresh).length;

    return {
      id: src.id,
      name: src.name,
      url: src.baseUrl,
      online,
      lastChecked: timestampMs,
      signalCount: sr.signals.length,
      freshSignalCount: freshCount,
      health,
      detail,
      live,
      tokenExpired,
      uptimeSec,
      activeStreams,
      error: sr.error,
    };
  });

  // ---- Build candle-aligned consensus ----
  // For each pair, group ALL signals by candle-time (minute-floored).
  // For each (pair, candle) we have at most one signal per app (latest wins).
  // Consensus is computed per-candle — only signals for the SAME candle
  // are compared.
  const pairMap = new Map<string, {
    otc: boolean;
    candles: Map<number, Partial<Record<AppId, SourceSignal>>>;
  }>();

  (["app1", "app2", "app3"] as AppId[]).forEach((id) => {
    for (const sig of sigResults[id].signals) {
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
      if (!cur || sig.timestamp > cur.timestamp) {
        candle[id] = sig;
      }
    }
  });

  const pairs: PairConsensus[] = [];
  pairMap.forEach((entry, pair) => {
    const candleEntries: any[] = [];
    entry.candles.forEach((appsMap, candleTime) => {
      const sigs: SourceSignal[] = [];
      let callCount = 0, putCount = 0, neutralCount = 0, freshCount = 0;
      const agreeing: AppId[] = [];
      const disagreeing: AppId[] = [];
      const missing: AppId[] = [];

      (["app1", "app2", "app3"] as AppId[]).forEach((id) => {
        const s = appsMap[id];
        if (!s || !s.fresh) { missing.push(id); return; }
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
        const dominant: Direction = callCount >= putCount ? "CALL" : "PUT";
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
        freshCount, callCount, putCount, neutralCount,
        consensus: {
          level, direction,
          agreeingApps: agreeing, disagreeingApps: disagreeing, missingApps: missing,
        },
      });
    });

    candleEntries.sort((a, b) => b.candleTime - a.candleTime);
    let latestCandle: any = null;
    if (candleEntries.length > 0) {
      latestCandle =
        candleEntries.find((c: any) => c.consensus.level === "3-agree") ??
        candleEntries.find((c: any) => c.consensus.level === "2-agree") ??
        candleEntries[0];
    }

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
      freshCount, callCount, putCount, neutralCount,
      consensus: latestCandle ? latestCandle.consensus : {
        level: "none" as ConsensusLevel, direction: null,
        agreeingApps: [], disagreeingApps: [],
        missingApps: ["app1", "app2", "app3"] as AppId[],
      },
    });
  });

  const levelOrder: Record<ConsensusLevel, number> = {
    "3-agree": 0, "2-agree": 1, conflict: 2, "1-only": 3, none: 4,
  };
  pairs.sort((a, b) => {
    const l = levelOrder[a.consensus.level] - levelOrder[b.consensus.level];
    if (l !== 0) return l;
    if (a.category !== b.category) return a.category === "otc" ? -1 : 1;
    return a.displayPair.localeCompare(b.displayPair);
  });

  return {
    timestamp: timestampMs,
    freshnessWindowSec: FRESHNESS_WINDOW_SEC,
    apps,
    pairs,
    summary: {
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
    },
  };
}

// ---------------------------------------------------------------------------
// Socket.IO server
// ---------------------------------------------------------------------------

const httpServer = createServer();
const io = new Server(httpServer, {
  // Use the default Socket.IO path "/socket.io/" so the browser client
  // can connect with io("/?XTransformPort=3003") and Caddy will forward
  // /socket.io/?...&XTransformPort=3003 to localhost:3003.
  path: "/socket.io/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  // Shorter ping interval so dead connections are detected quickly.
  pingInterval: 10000,
  pingTimeout: 20000,
  // Lower max payload so we don't hit proxy body limits.
  maxHttpBufferSize: 1e6,
});

let lastSnapshot: AggregatedResponse | null = null;
let lastHealthSignature: string = "";
let pushTimer: ReturnType<typeof setInterval> | null = null;

async function tick() {
  try {
    const snap = await aggregate();
    lastSnapshot = snap;

    // Always emit snapshot
    io.emit("snapshot", snap);

    // Emit "health" event only when the apps' health signature changes
    const sig = snap.apps
      .map((a) => `${a.id}:${a.health}:${a.online ? 1 : 0}:${a.tokenExpired ? 1 : 0}:${a.live ? 1 : 0}`)
      .join("|");
    if (sig !== lastHealthSignature) {
      lastHealthSignature = sig;
      io.emit("health", snap.apps);
      console.log(`[${new Date().toISOString()}] health changed: ${sig}`);
    }

    // Log a compact summary
    const s = snap.summary;
    console.log(
      `[${new Date().toISOString()}] pushed: ${s.totalPairs} pairs, 3A=${s.threeBotAgree.length}, 2A=${s.twoBotAgree.length}, conflict=${s.conflicts.length}, 1-only=${s.singleOnly.length} | apps: ${snap.apps.map((a) => `${a.id}=${a.health}`).join(",")}`
    );
  } catch (e: any) {
    // Log but DO NOT rethrow — we want the timer to keep ticking.
    console.error(`[${new Date().toISOString()}] tick error (continuing):`, e?.message ?? String(e));
  }
}

io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] client connected: ${socket.id}`);
  // Send the last snapshot immediately (if any) so the new client doesn't
  // have to wait up to PUSH_INTERVAL_MS for the next tick.
  if (lastSnapshot) {
    socket.emit("snapshot", lastSnapshot);
    socket.emit("health", lastSnapshot.apps);
  }
  // Client can request an immediate refresh
  socket.on("request-refresh", () => {
    console.log(`[${new Date().toISOString()}] client ${socket.id} requested refresh`);
    tick();
  });
  socket.on("disconnect", () => {
    console.log(`[${new Date().toISOString()}] client disconnected: ${socket.id}`);
  });
});

const PORT = 3003;
httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Signal Pusher WebSocket server running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Pushing every ${PUSH_INTERVAL_MS}ms (freshness window: ${FRESHNESS_WINDOW_SEC}s)`);
  // Kick off the first tick immediately
  tick();
  pushTimer = setInterval(tick, PUSH_INTERVAL_MS);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  if (pushTimer) clearInterval(pushTimer);
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down...");
  if (pushTimer) clearInterval(pushTimer);
  httpServer.close(() => process.exit(0));
});

// Catch unhandled promise rejections so they don't crash the process.
// The tick() already catches its own errors, but fetches inside aggregate()
// could still leak a rejection if something unexpected happens.
process.on("unhandledRejection", (reason) => {
  console.error(`[${new Date().toISOString()}] unhandledRejection (ignored):`, reason);
});
process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] uncaughtException (ignored):`, err?.message ?? err);
});
