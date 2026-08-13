/**
 * Signal Pusher Mini-Service
 * --------------------------
 * A standalone Socket.IO server that pushes the aggregated snapshot to every
 * connected browser every PUSH_INTERVAL_MS.
 *
 * IMPORTANT — this service does NOT aggregate anything itself.
 *
 * It used to carry its own ~500-line copy of the aggregator, and the two
 * copies drifted: the Next.js side gained the App 2 historical cache, the
 * candle-alignment fixes and the unit-normalized timestamps, while this copy
 * kept the old logic. Because the dashboard prefers the WebSocket payload over
 * its own polling, whenever this service was running it OVERWROTE the good
 * snapshot with the stale one — App 2 would disappear from the table even
 * though the Next.js API had it. There is now exactly one implementation
 * (src/lib/signal-aggregator.ts) and this process just relays it.
 *
 * Port: 3003 (configured in Caddyfile via XTransformPort)
 */

import { createServer } from "http";
import { Server } from "socket.io";

/** Where the single source of truth lives. */
const SNAPSHOT_URL = process.env.SNAPSHOT_URL ?? "http://127.0.0.1:3000/api/snapshot";
const PUSH_INTERVAL_MS = Number(process.env.PUSH_INTERVAL_MS ?? 5000);
const FETCH_TIMEOUT_MS = 15000;
const PORT = Number(process.env.PORT ?? 3003);

/** Minimal shape we depend on; the payload is passed through untouched. */
interface AggregatedSnapshot {
  timestamp: number;
  apps: Array<{
    id: string;
    health: string;
    online: boolean;
    tokenExpired?: boolean;
    live?: boolean;
  }>;
  pairs: unknown[];
  summary: {
    totalPairs: number;
    threeBotAgree: unknown[];
    twoBotAgree: unknown[];
    conflicts: unknown[];
    singleOnly: unknown[];
  };
}

async function fetchSnapshot(): Promise<AggregatedSnapshot | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SNAPSHOT_URL, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      // 503 just means the Next.js background poller hasn't finished its first
      // run yet — normal for the first few seconds after a deploy.
      console.warn(`[${new Date().toISOString()}] snapshot HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as AggregatedSnapshot;
    if (!json || !Array.isArray(json.pairs) || !Array.isArray(json.apps)) {
      console.warn(`[${new Date().toISOString()}] snapshot payload malformed — ignoring`);
      return null;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Socket.IO server
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  // Tiny health endpoint so a watchdog can tell "process up" from "relaying".
  if (req.url?.startsWith("/healthz")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: lastSnapshot != null,
        lastSnapshotAt,
        lastSnapshotAgeMs: lastSnapshotAt > 0 ? Date.now() - lastSnapshotAt : -1,
        clients: io.engine.clientsCount,
        source: SNAPSHOT_URL,
      })
    );
    return;
  }
  res.writeHead(404).end();
});

const io = new Server(httpServer, {
  // Default Socket.IO path so the browser can connect with
  // io("/?XTransformPort=3003") and Caddy forwards /socket.io/ to :3003.
  path: "/socket.io/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
});

let lastSnapshot: AggregatedSnapshot | null = null;
let lastSnapshotAt = 0;
let lastHealthSignature = "";
let pushTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;

async function tick() {
  // Never let two ticks overlap — a slow upstream used to stack requests.
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    const snap = await fetchSnapshot();
    if (!snap) return;

    lastSnapshot = snap;
    lastSnapshotAt = Date.now();
    io.emit("snapshot", snap);

    const sig = snap.apps
      .map((a) => `${a.id}:${a.health}:${a.online ? 1 : 0}:${a.tokenExpired ? 1 : 0}:${a.live ? 1 : 0}`)
      .join("|");
    if (sig !== lastHealthSignature) {
      lastHealthSignature = sig;
      io.emit("health", snap.apps);
      console.log(`[${new Date().toISOString()}] health changed: ${sig}`);
    }

    const s = snap.summary;
    console.log(
      `[${new Date().toISOString()}] pushed: ${s.totalPairs} pairs, 3A=${s.threeBotAgree.length}, 2A=${s.twoBotAgree.length}, conflict=${s.conflicts.length}, 1-only=${s.singleOnly.length} | apps: ${snap.apps.map((a) => `${a.id}=${a.health}`).join(",")}`
    );
  } catch (e: any) {
    // Log but DO NOT rethrow — the timer must keep ticking.
    console.error(`[${new Date().toISOString()}] tick error (continuing):`, e?.message ?? String(e));
  } finally {
    tickInProgress = false;
  }
}

io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] client connected: ${socket.id}`);
  // Send the last snapshot immediately so a new client doesn't wait a full
  // interval. Stale payloads are withheld: the browser polls /api/snapshot on
  // its own, and pushing a minute-old snapshot would only overwrite fresher
  // data the page already has.
  if (lastSnapshot && Date.now() - lastSnapshotAt < 3 * PUSH_INTERVAL_MS) {
    socket.emit("snapshot", lastSnapshot);
    socket.emit("health", lastSnapshot.apps);
  }
  socket.on("request-refresh", () => {
    console.log(`[${new Date().toISOString()}] client ${socket.id} requested refresh`);
    void tick();
  });
  socket.on("disconnect", () => {
    console.log(`[${new Date().toISOString()}] client disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Signal Pusher WebSocket server running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Relaying ${SNAPSHOT_URL} every ${PUSH_INTERVAL_MS}ms`);
  void tick();
  pushTimer = setInterval(() => { void tick(); }, PUSH_INTERVAL_MS);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);
  if (pushTimer) clearInterval(pushTimer);
  httpServer.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error(`[${new Date().toISOString()}] unhandledRejection (ignored):`, reason);
});
process.on("uncaughtException", (err: any) => {
  console.error(`[${new Date().toISOString()}] uncaughtException (ignored):`, err?.message ?? err);
});
