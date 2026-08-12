'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { io, Socket } from "socket.io-client"
import {
  Activity, ArrowDownCircle, ArrowUpCircle, Bot, Clock, Filter, Github,
  MinusCircle, Pause, Play, Radio, RefreshCw, TrendingDown, TrendingUp,
  Wifi, WifiOff, AlertTriangle, CheckCircle2, XCircle, Layers,
  Beaker, BarChart3, Trophy, Target, Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type {
  AggregatedResponse, AppId, AppStatus, ConsensusLevel,
  Direction, PairConsensus, SourceSignal,
} from "@/lib/signal-aggregator"
import type { BacktestResult, ConsensusLevel as BtLevel } from "@/lib/backtest-runner"

// Type-only re-export so we can import CandleConsensus in components below.
import type { CandleConsensus } from "@/lib/signal-aggregator"

const POLL_INTERVAL_MS = 5_000 // poll /api/snapshot every 5s (background poller refreshes cache every 5s)

// ---- helpers --------------------------------------------------------------

function fmtAgo(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

function fmtClock(ms: number): string {
  if (!ms) return "--:--:--"
  // Use the user's local timezone (no timeZone option). To avoid SSR/CSR
  // hydration mismatch, callers must ensure this is only invoked with
  // a real value on the client (e.g. via useState(0) + useEffect).
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false })
}

/** Format a unix-seconds timestamp as HH:MM:SS (UTC) — small, for table cells. */
function fmtSigTime(tsSec: number): string {
  if (!tsSec) return "--:--:--"
  return new Date(tsSec * 1000).toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" })
}

const CONSENSUS_META: Record<
  ConsensusLevel,
  { label: string; color: string; bg: string; border: string; ring: string }
> = {
  "3-agree": {
    label: "3 BOT AGREE",
    color: "text-emerald-300",
    bg: "bg-emerald-500/15",
    border: "border-emerald-500/40",
    ring: "ring-emerald-500/30",
  },
  "2-agree": {
    label: "2 BOT AGREE",
    color: "text-amber-300",
    bg: "bg-amber-500/15",
    border: "border-amber-500/40",
    ring: "ring-amber-500/30",
  },
  conflict: {
    label: "CONFLICT",
    color: "text-rose-300",
    bg: "bg-rose-500/15",
    border: "border-rose-500/40",
    ring: "ring-rose-500/30",
  },
  "1-only": {
    label: "SINGLE BOT",
    color: "text-slate-300",
    bg: "bg-slate-500/15",
    border: "border-slate-500/40",
    ring: "ring-slate-500/30",
  },
  none: {
    label: "NO SIGNAL",
    color: "text-slate-400",
    bg: "bg-slate-700/30",
    border: "border-slate-700/40",
    ring: "ring-slate-700/30",
  },
}

const APP_META: Record<AppId, { shortName: string; name: string; accent: string }> = {
  app1: { shortName: "App 1", name: "Minimum Pair", accent: "amber" },
  app2: { shortName: "App 2", name: "Binary Signal Terminal", accent: "violet" },
  app3: { shortName: "App 3", name: "OTC Live Trading", accent: "emerald" },
}

function DirectionPill({ dir, size = "md" }: { dir: Direction | null; size?: "sm" | "md" }) {
  const sz = size === "sm" ? "h-6 px-2 text-[11px]" : "h-8 px-3 text-sm"
  if (dir === "CALL") {
    return (
      <span className={cn(
        "inline-flex items-center gap-1 rounded-md font-bold tracking-wide",
        "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
        sz
      )}>
        <TrendingUp className="h-3.5 w-3.5" /> CALL
      </span>
    )
  }
  if (dir === "PUT") {
    return (
      <span className={cn(
        "inline-flex items-center gap-1 rounded-md font-bold tracking-wide",
        "bg-rose-500/20 text-rose-300 border border-rose-500/40",
        sz
      )}>
        <TrendingDown className="h-3.5 w-3.5" /> PUT
      </span>
    )
  }
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-md font-medium tracking-wide",
      "bg-slate-700/40 text-slate-400 border border-slate-700/40",
      sz
    )}>
      <MinusCircle className="h-3.5 w-3.5" /> —
    </span>
  )
}

// ---- main page ------------------------------------------------------------

export default function Home() {
  const [data, setData] = useState<AggregatedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [filter, setFilter] = useState<"all" | "3-agree" | "2-agree" | "conflict">("all")
  const [categoryFilter, setCategoryFilter] = useState<"all" | "otc" | "real">("all")
  const [lastUpdated, setLastUpdated] = useState<number>(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const socketRef = useRef<Socket | null>(null)

  // WebSocket connection state
  const [wsConnected, setWsConnected] = useState(false)
  // Tracks whether we've ever received data via WS — used to know whether
  // to fall back to polling if WS doesn't deliver.
  const wsReceivedRef = useRef(false)
  // Last time we received any data (WS or REST) — used to show "LIVE" if
  // data is flowing, even if WS itself dropped (Caddy/proxy can be flaky).
  const [lastDataAt, setLastDataAt] = useState<number>(0)
  // Tracks whether we're using the fast 5s poller (Next.js /api/snapshot)
  // or the slower 15s /api/aggregated fallback.
  const [fastPoller, setFastPoller] = useState(false)

  // Backtest state
  const [backtest, setBacktest] = useState<BacktestResult | null>(null)
  const [btLoading, setBtLoading] = useState(false)
  const [btError, setBtError] = useState<string | null>(null)

  const runBacktest = useCallback(async () => {
    setBtLoading(true)
    setBtError(null)
    try {
      const res = await fetch("/api/backtest", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: BacktestResult = await res.json()
      setBacktest(json)
    } catch (e: any) {
      setBtError(e?.message ?? "Backtest failed")
    } finally {
      setBtLoading(false)
    }
  }, [])

  // Auto-run backtest on mount (after 5s to let the snapshot load first)
  // and then every 2 minutes so the win-rate panel stays current.
  useEffect(() => {
    const initialTimer = setTimeout(() => { runBacktest(); }, 5000);
    const intervalTimer = setInterval(() => { runBacktest(); }, 120000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [runBacktest]);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setIsRefreshing(true)
    try {
      // Try the fast snapshot endpoint first (backed by a 5s background poller).
      let res: Response;
      try {
        res = await fetch("/api/snapshot", { cache: "no-store" });
        if (res.ok) {
          const json: AggregatedResponse = await res.json();
          setData(json);
          setLastUpdated(Date.now());
          setLastDataAt(Date.now());
          setFastPoller(true);
          setError(null);
          return;
        }
      } catch {
        // fall through to /api/aggregated
      }
      // Fallback: slow aggregated endpoint (no background poller).
      res = await fetch("/api/aggregated", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: AggregatedResponse = await res.json();
      setData(json);
      setLastUpdated(Date.now());
      setLastDataAt(Date.now());
      setFastPoller(false);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "Failed to fetch aggregated signals");
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [])

  // WebSocket connection — real-time updates every 5s from mini-service
  useEffect(() => {
    // Connect to the signal-pusher mini-service on port 3003 via Caddy.
    // Caddy routes /socket.io/?...&XTransformPort=3003 to localhost:3003.
    // We put "polling" first because some proxies (Caddy reverse_proxy
    // with query-based port routing) don't reliably upgrade WebSocket.
    // Socket.IO will still try to upgrade to websocket after the first
    // successful polling handshake, and silently fall back if it fails.
    const sock = io("/?XTransformPort=3003", {
      transports: ["polling", "websocket"],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 8000,
      timeout: 15000,
    });
    socketRef.current = sock;

    sock.on("connect", () => {
      setWsConnected(true);
      console.log("[ws] connected to signal-pusher");
    });
    sock.on("disconnect", () => {
      setWsConnected(false);
      console.log("[ws] disconnected");
    });
    sock.on("connect_error", (err: any) => {
      setWsConnected(false);
      console.warn("[ws] connect_error:", err?.message);
    });
    sock.on("snapshot", (snap: AggregatedResponse) => {
      wsReceivedRef.current = true;
      setData(snap);
      setLastUpdated(Date.now());
      setLastDataAt(Date.now());
      setLoading(false);
      setError(null);
    });
    sock.on("health", (apps: AppStatus[]) => {
      // Health-only update — we just merge into the existing snapshot
      // to avoid a full re-render. The next snapshot will overwrite.
      setData((prev) => prev ? { ...prev, apps } : prev);
    });

    return () => {
      sock.disconnect();
      socketRef.current = null;
    };
  }, []);

  // Polling loop — polls /api/snapshot every 5s.
  // This is our primary data source (the background poller inside Next.js
  // refreshes the cache every 5s). WebSocket is a bonus optimization that
  // we still try to use, but polling alone is sufficient.
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!autoRefresh) return;
    // Initial fetch
    fetchData(true);
    timerRef.current = setInterval(() => fetchData(true), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, fetchData]);

  // Manual refresh — forces an immediate re-poll via /api/snapshot?refresh=1
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await fetch("/api/snapshot?refresh=1", { cache: "no-store" });
      if (res.ok) {
        const json: AggregatedResponse = await res.json();
        setData(json);
        setLastUpdated(Date.now());
        setLastDataAt(Date.now());
        setFastPoller(true);
        setError(null);
      } else {
        // Fall back to normal fetch
        await fetchData();
      }
    } catch {
      await fetchData();
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchData]);

  // Live state: data has arrived within the last 12s.
  // We show "LIVE" whenever fresh data is flowing, whether it came via
  // WebSocket push or HTTP polling. The 12s threshold is 2x our 5s poll
  // interval, so a single missed poll won't flip us to "POLL".
  const isLive = wsConnected || (lastDataAt > 0 && Date.now() - lastDataAt < 12000);

  // Force a re-render every 5s so the "LIVE" badge correctly falls back to
  // "POLL" if no data has arrived within 12s. Without this, the badge would
  // stay stuck on "LIVE" until the next user interaction.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // Per-second wall clock — shown in the header so the user sees a ticking
  // HH:MM:SS even between data updates. Updates every 1s.
  // Initialize to 0 so SSR renders "--:--:--" (placeholder). The actual
  // time is set in useEffect after mount, which avoids hydration mismatch
  // (server time vs client time / timezone would otherwise differ).
  const [nowSec, setNowSec] = useState<number>(0);
  useEffect(() => {
    setNowSec(Date.now());
    const t = setInterval(() => setNowSec(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const filteredPairs = useMemo(() => {
    if (!data) return []
    return data.pairs.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false
      if (filter === "all") return true
      return p.consensus.level === filter
    })
  }, [data, filter, categoryFilter])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur supports-[backdrop-filter]:bg-slate-950/70">
        <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <div className="absolute inset-0 bg-emerald-500/40 blur-lg rounded-full" />
              <div className="relative h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <Radio className="h-5 w-5 text-white" />
              </div>
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight leading-tight">
                QX Signal Aggregator
              </h1>
              <p className="text-[11px] text-slate-400 leading-tight">
                3-app consensus dashboard · CALL/PUT
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {/* WebSocket connection indicator */}
            <div
              className={cn(
                "flex items-center gap-1.5 px-2 h-8 rounded-md border text-xs",
                isLive
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
              )}
              title={isLive
                ? (wsConnected
                    ? "Real-time WebSocket connected (5s push)"
                    : fastPoller
                    ? "Live data via 5s background poller"
                    : "Receiving live data via polling")
                : "No recent data — check connection"}
            >
              {isLive ? (
                <><Zap className="h-3 w-3" /> LIVE</>
              ) : (
                <><RefreshCw className="h-3 w-3 animate-pulse" /> POLL</>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400 mr-1">
              <Clock className="h-3.5 w-3.5" />
              <span className="tabular-nums text-slate-200 font-semibold">
                {fmtClock(nowSec)}
              </span>
              {lastUpdated > 0 && (
                <span className="text-slate-500 ml-1" title="Last data update">
                  ·data {fmtClock(lastUpdated)}
                </span>
              )}
            </div>
            <div className="h-4 w-px bg-slate-700" />
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="h-8 border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
              Refresh
            </Button>
            <div className="flex items-center gap-2 px-2.5 h-8 rounded-md border border-slate-700 bg-slate-900">
              <span className="text-xs text-slate-400">Auto</span>
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                className="scale-90"
              />
              {autoRefresh ? (
                <Play className="h-3 w-3 text-emerald-400" />
              ) : (
                <Pause className="h-3 w-3 text-slate-500" />
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl w-full px-4 py-5 flex-1 space-y-5">
        {/* Error banner */}
        {error && (
          <Card className="p-3 border-rose-500/40 bg-rose-500/10 text-rose-200 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">Failed to refresh signals: {error}</span>
          </Card>
        )}

        {/* Loading skeleton */}
        {loading && !data && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-28 rounded-xl bg-slate-800/60" />
              ))}
            </div>
            <Skeleton className="h-24 rounded-xl bg-slate-800/60" />
            <Skeleton className="h-96 rounded-xl bg-slate-800/60" />
          </div>
        )}

        {data && (
          <>
            {/* App status cards */}
            <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {data.apps.map((app) => (
                <AppStatusCard key={app.id} app={app} />
              ))}
            </section>

            {/* Summary stats */}
            <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <SummaryCard
                label="Total Pairs"
                value={data.summary.totalPairs}
                icon={<Layers className="h-4 w-4" />}
                tone="slate"
              />
              <SummaryCard
                label="3 Bot Agree"
                value={data.summary.threeBotAgree.length}
                icon={<CheckCircle2 className="h-4 w-4" />}
                tone="emerald"
                pulse={data.summary.threeBotAgree.length > 0}
              />
              <SummaryCard
                label="2 Bot Agree"
                value={data.summary.twoBotAgree.length}
                icon={<Activity className="h-4 w-4" />}
                tone="amber"
              />
              <SummaryCard
                label="Conflicts"
                value={data.summary.conflicts.length}
                icon={<AlertTriangle className="h-4 w-4" />}
                tone="rose"
              />
              <SummaryCard
                label="CALL / PUT"
                value={`${data.summary.pairsByDirection.CALL} / ${data.summary.pairsByDirection.PUT}`}
                icon={<TrendingUp className="h-4 w-4" />}
                tone="teal"
              />
            </section>

            {/* Consensus highlights (3-bot agree + 2-bot agree) */}
            {(data.summary.threeBotAgree.length > 0 || data.summary.twoBotAgree.length > 0) && (
              <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <ConsensusHighlight
                  title="3 BOT AGREE — STRONG SIGNAL"
                  pairs={data.summary.threeBotAgree}
                  variant="emerald"
                />
                <ConsensusHighlight
                  title="2 BOT AGREE — MEDIUM SIGNAL"
                  pairs={data.summary.twoBotAgree}
                  variant="amber"
                />
              </section>
            )}

            {/* Filter bar */}
            <section className="flex items-center gap-2 flex-wrap">
              <Filter className="h-4 w-4 text-slate-400" />
              <span className="text-xs text-slate-400 mr-1">Consensus:</span>
              {([
                ["all", "All"],
                ["3-agree", "3 Agree"],
                ["2-agree", "2 Agree"],
                ["conflict", "Conflict"],
              ] as const).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant="ghost"
                  onClick={() => setFilter(key)}
                  className={cn(
                    "h-7 px-2.5 text-xs",
                    filter === key
                      ? "bg-slate-700 text-white hover:bg-slate-700"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                  )}
                >
                  {label}
                </Button>
              ))}
              <div className="h-4 w-px bg-slate-700 mx-1" />
              <span className="text-xs text-slate-400 mr-1">Type:</span>
              {([
                ["all", "All"],
                ["otc", "OTC"],
                ["real", "Real"],
              ] as const).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant="ghost"
                  onClick={() => setCategoryFilter(key)}
                  className={cn(
                    "h-7 px-2.5 text-xs",
                    categoryFilter === key
                      ? "bg-slate-700 text-white hover:bg-slate-700"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                  )}
                >
                  {label}
                </Button>
              ))}
              <div className="ml-auto text-xs text-slate-500">
                Showing {filteredPairs.length} / {data.pairs.length} pairs
              </div>
            </section>

            {/* Pair table */}
            <section className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/80">
                      <th className="text-left font-semibold text-slate-300 px-4 py-2.5">Pair</th>
                      <th className="text-center font-semibold text-slate-300 px-2 py-2.5">
                        <div className="flex flex-col items-center gap-0.5">
                          <span>App 1</span>
                          <span className="text-[10px] text-slate-500 font-normal">Min Pair</span>
                        </div>
                      </th>
                      <th className="text-center font-semibold text-slate-300 px-2 py-2.5">
                        <div className="flex flex-col items-center gap-0.5">
                          <span>App 2</span>
                          <span className="text-[10px] text-slate-500 font-normal">Binary Term</span>
                        </div>
                      </th>
                      <th className="text-center font-semibold text-slate-300 px-2 py-2.5">
                        <div className="flex flex-col items-center gap-0.5">
                          <span>App 3</span>
                          <span className="text-[10px] text-slate-500 font-normal">OTC Live</span>
                        </div>
                      </th>
                      <th className="text-center font-semibold text-slate-300 px-2 py-2.5">Consensus</th>
                      <th className="text-left font-semibold text-slate-300 px-4 py-2.5">Signal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPairs.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-500 text-sm">
                          No pairs match the current filter.
                        </td>
                      </tr>
                    )}
                    {filteredPairs.map((p) => (
                      <PairRow key={p.pair} pair={p} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Backtest verification panel */}
            <section>
              <Card className="border-slate-800 bg-slate-900/50">
                <div className="p-4 border-b border-slate-800 flex items-center gap-2 flex-wrap">
                  <Beaker className="h-4 w-4 text-cyan-400" />
                  <h2 className="text-sm font-bold tracking-wide text-slate-100">
                    Backtest Verification
                  </h2>
                  <span className="text-[11px] text-slate-500">
                    Live cross-source accuracy check
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={runBacktest}
                    disabled={btLoading}
                    className="ml-auto h-7 border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200"
                  >
                    {btLoading ? (
                      <><RefreshCw className="h-3 w-3 animate-spin" /> Running...</>
                    ) : (
                      <><BarChart3 className="h-3 w-3" /> Run Backtest</>
                    )}
                  </Button>
                </div>

                <div className="p-4">
                  {btError && (
                    <div className="mb-3 p-2.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 text-xs flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5" /> {btError}
                    </div>
                  )}

                  {!backtest && !btLoading && !btError && (
                    <div className="text-sm text-slate-400 py-6 text-center">
                      Click <strong className="text-slate-200">Run Backtest</strong> to fetch historical signals from all 3 apps and verify the consensus logic with real win/loss data.
                    </div>
                  )}

                  {btLoading && (
                    <div className="space-y-3">
                      <Skeleton className="h-20 rounded-md bg-slate-800/60" />
                      <Skeleton className="h-40 rounded-md bg-slate-800/60" />
                    </div>
                  )}

                  {backtest && !btLoading && (
                    <BacktestContent result={backtest} />
                  )}
                </div>
              </Card>
            </section>

            {/* Freshness legend */}
            <section className="flex items-center justify-between flex-wrap gap-2 text-xs text-slate-500">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" /> Fresh ({`≤ ${Math.floor(data.freshnessWindowSec / 60)}m`})
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-slate-600" /> Stale / no signal
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-amber-500" /> Token issue
                </span>
              </div>
              <span>
                Polling every {POLL_INTERVAL_MS / 1000}s · Server time: {fmtClock(data.timestamp)}
              </span>
            </section>
          </>
        )}
      </main>

      <footer className="border-t border-slate-800 mt-auto">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between flex-wrap gap-2 text-xs text-slate-500">
          <span>
            Aggregates CALL/PUT signals from 3 Quotex analysis apps. For educational use — not financial advice.
          </span>
          <span className="flex items-center gap-1">
            <Github className="h-3 w-3" /> Built on Next.js 16
          </span>
        </div>
      </footer>
    </div>
  )
}

// ---- subcomponents --------------------------------------------------------

function AppStatusCard({ app }: { app: AppStatus }) {
  const meta = APP_META[app.id]
  const isOnline = app.online
  const tokenIssue = app.health === "token_expired"
  const disconnected = app.health === "disconnected"
  const down = app.health === "down"

  // Determine status badge content + color
  let statusLabel: string
  let statusColor: string
  let statusBg: string
  let statusBorder: string
  let StatusIcon: typeof Wifi | typeof WifiOff | typeof AlertTriangle

  if (down) {
    statusLabel = "OFFLINE"
    statusColor = "text-rose-300"
    statusBg = "bg-rose-500/15"
    statusBorder = "border-rose-500/40"
    StatusIcon = WifiOff
  } else if (tokenIssue) {
    statusLabel = "TOKEN EXPIRED"
    statusColor = "text-amber-300"
    statusBg = "bg-amber-500/15"
    statusBorder = "border-amber-500/40"
    StatusIcon = AlertTriangle
  } else if (disconnected) {
    statusLabel = "DISCONNECTED"
    statusColor = "text-amber-300"
    statusBg = "bg-amber-500/15"
    statusBorder = "border-amber-500/40"
    StatusIcon = WifiOff
  } else if (app.live) {
    statusLabel = "LIVE"
    statusColor = "text-emerald-300"
    statusBg = "bg-emerald-500/15"
    statusBorder = "border-emerald-500/40"
    StatusIcon = Wifi
  } else {
    statusLabel = "ONLINE"
    statusColor = "text-emerald-300"
    statusBg = "bg-emerald-500/15"
    statusBorder = "border-emerald-500/40"
    StatusIcon = Wifi
  }

  const cardBorder = down || tokenIssue || disconnected ? "border-rose-500/30" : "border-slate-800"

  return (
    <Card
      className={cn(
        "p-4 border bg-slate-900/60 relative overflow-hidden",
        cardBorder
      )}
    >
      <div
        className={cn(
          "absolute top-0 left-0 right-0 h-0.5",
          down ? "bg-rose-500" :
          tokenIssue ? "bg-amber-500" :
          disconnected ? "bg-amber-500" :
          app.id === "app1" ? "bg-amber-500" :
          app.id === "app2" ? "bg-violet-500" : "bg-emerald-500"
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              "h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0",
              down ? "bg-rose-500/15 text-rose-400" :
              tokenIssue ? "bg-amber-500/15 text-amber-400" :
              disconnected ? "bg-amber-500/15 text-amber-400" :
              app.id === "app1" ? "bg-amber-500/15 text-amber-400" :
              app.id === "app2" ? "bg-violet-500/15 text-violet-400" :
              "bg-emerald-500/15 text-emerald-400"
            )}
          >
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-100 truncate">
              {meta.shortName}
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {meta.name}
            </div>
          </div>
        </div>
        <div
          className={cn(
            "flex items-center gap-1 px-1.5 py-0.5 rounded border flex-shrink-0",
            statusBg, statusBorder, statusColor
          )}
          title={app.detail ?? statusLabel}
        >
          <StatusIcon className="h-3 w-3" />
          <span className="text-[9px] font-bold tracking-wider">{statusLabel}</span>
        </div>
      </div>

      {/* Status detail line — always visible so user can see exactly why */}
      <div className="mt-2.5 text-[11px] leading-snug">
        {app.detail && (
          <div className={cn("flex items-start gap-1", statusColor)}>
            <span className="text-slate-500 font-medium flex-shrink-0">Status:</span>
            <span className="text-slate-300 break-all">{app.detail}</span>
          </div>
        )}
        {!app.detail && down && (
          <div className="text-rose-300 flex items-center gap-1">
            <span className="text-slate-500 font-medium">Status:</span>
            <span>Source app not responding — fetch failed</span>
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-slate-800/50 px-2 py-1.5">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Signals</div>
          <div className="text-slate-200 font-semibold tabular-nums">
            {app.signalCount}
          </div>
        </div>
        <div className="rounded-md bg-slate-800/50 px-2 py-1.5">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Fresh</div>
          <div className={cn(
            "font-semibold tabular-nums",
            app.freshSignalCount > 0 ? "text-emerald-300" : "text-slate-500"
          )}>
            {app.freshSignalCount}
          </div>
        </div>
      </div>

      {/* Extra health metadata */}
      <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px] text-slate-500">
        {typeof app.uptimeSec === "number" && (
          <span title="Upstream uptime">
            up {app.uptimeSec >= 3600 ? `${Math.floor(app.uptimeSec / 3600)}h` :
                app.uptimeSec >= 60 ? `${Math.floor(app.uptimeSec / 60)}m` :
                `${app.uptimeSec}s`}
          </span>
        )}
        {typeof app.activeStreams === "number" && (
          <span title="Active pair streams">{app.activeStreams} streams</span>
        )}
        {typeof app.latencyMs === "number" && (
          <span title="Last fetch latency">{app.latencyMs}ms</span>
        )}
      </div>

      {app.error && (
        <div className="mt-2 text-[10px] text-rose-300/80 truncate" title={app.error}>
          Error: {app.error}
        </div>
      )}
      <a
        href={app.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-[10px] text-slate-500 hover:text-slate-300 truncate max-w-full"
      >
        {app.url.replace("https://", "")}
      </a>
    </Card>
  )
}

function SummaryCard({
  label, value, icon, tone, pulse = false,
}: {
  label: string
  value: number | string
  icon: React.ReactNode
  tone: "slate" | "emerald" | "amber" | "rose" | "teal"
  pulse?: boolean
}) {
  const tones: Record<string, string> = {
    slate: "border-slate-800 bg-slate-900/40 text-slate-300",
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    rose: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    teal: "border-teal-500/30 bg-teal-500/10 text-teal-300",
  }
  return (
    <Card className={cn("p-3 border", tones[tone])}>
      <div className="flex items-center gap-2 mb-1">
        <span className={cn("opacity-70", pulse && "animate-pulse")}>{icon}</span>
        <span className="text-[11px] uppercase tracking-wide opacity-70">{label}</span>
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </Card>
  )
}

function ConsensusHighlight({
  title, pairs, variant,
}: {
  title: string
  pairs: PairConsensus[]
  variant: "emerald" | "amber"
}) {
  const styles = {
    emerald: {
      card: "border-emerald-500/40 bg-gradient-to-br from-emerald-950/60 to-slate-900/40",
      title: "text-emerald-300",
      glow: "shadow-emerald-500/10",
    },
    amber: {
      card: "border-amber-500/40 bg-gradient-to-br from-amber-950/60 to-slate-900/40",
      title: "text-amber-300",
      glow: "shadow-amber-500/10",
    },
  }[variant]

  return (
    <Card className={cn("p-4 border shadow-lg", styles.card, styles.glow)}>
      <div className="flex items-center gap-2 mb-3">
        <div
          className={cn(
            "h-2 w-2 rounded-full",
            variant === "emerald" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
          )}
        />
        <h2 className={cn("text-sm font-bold tracking-wide", styles.title)}>
          {title}
        </h2>
        <Badge
          variant="outline"
          className={cn(
            "ml-auto text-[11px] border-current/30",
            variant === "emerald" ? "text-emerald-300" : "text-amber-300"
          )}
        >
          {pairs.length} pair{pairs.length !== 1 ? "s" : ""}
        </Badge>
      </div>
      {pairs.length === 0 ? (
        <div className="text-xs text-slate-500 py-2">No active signals right now.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {pairs.map((p) => (
            <div
              key={p.pair}
              className={cn(
                "rounded-lg border px-3 py-2 flex items-center justify-between gap-2",
                variant === "emerald"
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-amber-500/30 bg-amber-500/5"
              )}
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-100 truncate">
                  {p.displayPair}
                </div>
                <div className="text-[10px] text-slate-400 uppercase tracking-wide">
                  {p.category}
                </div>
              </div>
              <DirectionPill dir={p.consensus.direction} />
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---- Backtest content subcomponent ---------------------------------------

function BacktestContent({ result }: { result: BacktestResult }) {
  const fmtPct = (n: number, d: number) => (d > 0 ? `${(n / d * 100).toFixed(1)}%` : "—")
  const levels: BtLevel[] = ["3-agree", "2-agree", "conflict", "1-only"]
  const verdictIcon = {
    validated: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
    partial: <AlertTriangle className="h-4 w-4 text-amber-400" />,
    anomaly: <XCircle className="h-4 w-4 text-rose-400" />,
    insufficient: <AlertTriangle className="h-4 w-4 text-slate-400" />,
  }[result.verdict.kind]
  const verdictTone = {
    validated: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    partial: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    anomaly: "border-rose-500/40 bg-rose-500/10 text-rose-200",
    insufficient: "border-slate-700 bg-slate-800/40 text-slate-300",
  }[result.verdict.kind]

  return (
    <div className="space-y-4">
      {/* Verdict banner */}
      <div className={cn("rounded-lg border p-3 flex items-start gap-2.5", verdictTone)}>
        <div className="mt-0.5 flex-shrink-0">{verdictIcon}</div>
        <div className="min-w-0">
          <div className="text-sm font-semibold capitalize">
            {result.verdict.kind === "validated" && "Consensus Logic Validated"}
            {result.verdict.kind === "partial" && "Partial Validation"}
            {result.verdict.kind === "anomaly" && "Anomaly Detected"}
            {result.verdict.kind === "insufficient" && "Insufficient Graded Data"}
          </div>
          <div className="text-xs opacity-90 mt-0.5">{result.verdict.message}</div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {levels.map((lvl) => {
          const s = result.levels[lvl]
          const graded = s.win + s.loss
          const wr = graded > 0 ? (s.win / graded * 100) : 0
          const tone =
            lvl === "3-agree" ? "emerald" :
            lvl === "2-agree" ? "amber" :
            lvl === "conflict" ? "rose" : "slate"
          const toneCls = {
            emerald: "border-emerald-500/30 bg-emerald-500/5",
            amber: "border-amber-500/30 bg-amber-500/5",
            rose: "border-rose-500/30 bg-rose-500/5",
            slate: "border-slate-700 bg-slate-800/30",
          }[tone]
          return (
            <div key={lvl} className={cn("rounded-lg border p-3", toneCls)}>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
                {lvl === "3-agree" ? "3 BOT AGREE" :
                 lvl === "2-agree" ? "2 BOT AGREE" :
                 lvl === "conflict" ? "CONFLICT" : "SINGLE BOT"}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums text-slate-100">
                {graded > 0 ? `${wr.toFixed(1)}%` : "—"}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                {s.win}W / {s.loss}L / {s.unknown}?  · {s.total} total
              </div>
            </div>
          )
        })}
      </div>

      {/* Source app accuracy */}
      <div>
        <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
          <Trophy className="h-3.5 w-3.5 text-amber-400" /> Source App Individual Accuracy
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {(["app1", "app2", "app3"] as AppId[]).map((id) => {
            const s = result.sources[id]
            const graded = s.win + s.loss
            const wr = graded > 0 ? (s.win / graded * 100) : 0
            const name = id === "app1" ? "App 1 · Minimum Pair" :
                         id === "app2" ? "App 2 · Binary Term" : "App 3 · OTC Live"
            return (
              <div key={id} className="rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
                <div className="text-[11px] text-slate-400">{name}</div>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-lg font-bold tabular-nums text-slate-100">
                    {graded > 0 ? `${wr.toFixed(1)}%` : "—"}
                  </span>
                  <span className="text-[10px] text-slate-500 tabular-nums">
                    {s.win}W / {s.loss}L / {s.unknown}?
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{s.total} total signals</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Sample 2-agree signals */}
      {result.sampleTwoAgree.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
            <Target className="h-3.5 w-3.5 text-amber-400" /> Recent 2-Bot-Agree Outcomes
          </div>
          <div className="rounded-md border border-slate-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-900/70 border-b border-slate-800">
                  <th className="text-left font-medium text-slate-400 px-3 py-1.5">Time (UTC)</th>
                  <th className="text-left font-medium text-slate-400 px-3 py-1.5">Pair</th>
                  <th className="text-center font-medium text-slate-400 px-3 py-1.5">Direction</th>
                  <th className="text-center font-medium text-slate-400 px-3 py-1.5">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {result.sampleTwoAgree.slice(0, 8).map((c, i) => (
                  <tr key={i} className="border-b border-slate-800/40 last:border-0">
                    <td className="px-3 py-1.5 text-slate-300 tabular-nums">
                      {new Date(c.ts * 1000).toISOString().slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="px-3 py-1.5 text-slate-200 font-medium">{c.pair}</td>
                    <td className="px-3 py-1.5 text-center">
                      <DirectionPill dir={c.direction as Direction} size="sm" />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <span className={cn(
                        "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold",
                        c.outcome === 1 ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
                      )}>
                        {c.outcome === 1 ? "WIN" : "LOSS"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="text-[11px] text-slate-500 flex items-center justify-between flex-wrap gap-2 pt-1">
        <span>
          Analyzed <strong className="text-slate-300">{result.totalSignals}</strong> signals →
          {" "}<strong className="text-slate-300">{result.totalClusters}</strong> consensus clusters
        </span>
        <span className="tabular-nums">
          Backtest ran at: {new Date(result.timestamp).toLocaleTimeString("en-GB", { hour12: false })}
        </span>
      </div>
    </div>
  )
}

function PairRow({ pair }: { pair: PairConsensus }) {
  const [expanded, setExpanded] = useState(false)
  // Defensive: any of these fields may be missing if the snapshot came from
  // an older cached version (e.g. mini-service hasn't been updated yet, or
  // browser received a stale WS payload). Fall back to safe defaults so the
  // table never crashes the page.
  const c = pair.consensus ?? {
    level: "none" as ConsensusLevel,
    direction: null,
    agreeingApps: [],
    disagreeingApps: [],
    missingApps: [],
  }
  const meta = CONSENSUS_META[c.level] ?? CONSENSUS_META.none
  const lc = pair.latestCandle ?? null
  const candles = Array.isArray(pair.candles) ? pair.candles : []
  const signals = Array.isArray(pair.signals) ? pair.signals : []

  const getSignal = (id: AppId): SourceSignal | undefined =>
    signals.find((s) => s.source === id)

  return (
    <>
      <tr
        className={cn(
          "border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors cursor-pointer",
          c.level === "3-agree" && "bg-emerald-500/[0.04]",
          c.level === "2-agree" && "bg-amber-500/[0.04]",
          c.level === "conflict" && "bg-rose-500/[0.04]"
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <div>
              <div className="font-medium text-slate-100">{pair.displayPair}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                {pair.category}
              </div>
            </div>
            {lc && (
              <div className="ml-auto text-right">
                <div className="text-[10px] text-slate-500 uppercase tracking-wide leading-none">Candle</div>
                <div
                  className="text-[12px] font-semibold tabular-nums text-cyan-300 leading-tight"
                  title={`Candle time (UTC, minute-floored)\nThis is the candle that the signals below are predicting.`}
                >
                  {fmtSigTime(lc.candleTime)}
                </div>
              </div>
            )}
          </div>
        </td>
        {(["app1", "app2", "app3"] as AppId[]).map((id) => {
          const sig = getSignal(id)
          return (
            <td key={id} className="px-2 py-2.5 text-center align-middle">
              {sig ? (
                <div className="flex flex-col items-center gap-0.5">
                  <DirectionPill dir={sig.direction} size="sm" />
                  <span
                    className={cn(
                      "text-[10px] tabular-nums leading-tight",
                      sig.fresh ? "text-slate-400" : "text-slate-600"
                    )}
                    title={`Signal timestamp (UTC): ${fmtSigTime(sig.timestamp)}\nCandle: ${fmtSigTime(sig.candleTime)}\nAge: ${fmtAgo(sig.ageSec)}`}
                  >
                    {fmtSigTime(sig.timestamp)}
                  </span>
                </div>
              ) : (
                <span className="inline-flex items-center justify-center h-6 px-2 text-[11px] text-slate-600 rounded-md border border-slate-800 bg-slate-900/40">
                  —
                </span>
              )}
            </td>
          )
        })}
        <td className="px-2 py-2.5 text-center">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold border",
              meta.bg, meta.color, meta.border
            )}
          >
            {meta.label}
          </span>
        </td>
        <td className="px-4 py-2.5">
          {c.direction ? (
            <div className="flex items-center gap-2">
              <DirectionPill dir={c.direction} />
              <span className="text-[11px] text-slate-500">
                {c.agreeingApps.length}/{c.agreeingApps.length + c.disagreeingApps.length}
              </span>
            </div>
          ) : (
            <span className="text-xs text-slate-500">—</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-900/40 border-b border-slate-800/60">
          <td colSpan={6} className="px-4 py-3">
            {/* Per-app detail for the latest candle */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
              {(["app1", "app2", "app3"] as AppId[]).map((id) => {
                const sig = getSignal(id)
                const m = APP_META[id]
                return (
                  <div
                    key={id}
                    className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-300">
                        {m.shortName}
                      </span>
                      {sig ? <DirectionPill dir={sig.direction} size="sm" /> : (
                        <span className="text-[10px] text-slate-600">NO SIGNAL</span>
                      )}
                    </div>
                    {sig ? (
                      <div className="space-y-1 text-[11px] text-slate-400">
                        <div className="flex justify-between">
                          <span>Candle</span>
                          <span className="text-cyan-300 tabular-nums">{fmtSigTime(sig.candleTime)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Signal at</span>
                          <span className="text-slate-300 tabular-nums">{fmtSigTime(sig.timestamp)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Age</span>
                          <span className="text-slate-300 tabular-nums">
                            {fmtAgo(sig.ageSec)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>Confidence</span>
                          <span className="text-slate-300 tabular-nums">
                            {sig.confidence !== null
                              ? `${(sig.confidence * 100).toFixed(1)}%`
                              : "—"}
                          </span>
                        </div>
                        {sig.strength && (
                          <div className="flex justify-between">
                            <span>Strength</span>
                            <span className="text-slate-300">{sig.strength}</span>
                          </div>
                        )}
                        {sig.outcome && (
                          <div className="flex justify-between">
                            <span>Outcome</span>
                            <span
                              className={cn(
                                "font-medium",
                                sig.outcome === "WIN" || sig.outcome === "CORRECT"
                                  ? "text-emerald-400"
                                  : sig.outcome === "LOSS" || sig.outcome === "WRONG"
                                  ? "text-rose-400"
                                  : "text-slate-300"
                              )}
                            >
                              {sig.outcome}
                            </span>
                          </div>
                        )}
                        {sig.strategy && (
                          <div className="flex justify-between gap-2">
                            <span>Strategy</span>
                            <span className="text-slate-300 text-right truncate max-w-[140px]" title={sig.strategy}>
                              {sig.strategy}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-600">
                        No signal from this app for this candle.
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Historical candles table — shows candle-aligned consensus over time */}
            {candles.length > 1 && (
              <div>
                <div className="text-[11px] font-semibold text-slate-400 mb-1.5 flex items-center gap-1.5">
                  <Clock className="h-3 w-3" />
                  Candle-aligned history ({candles.length} candles, newest first)
                </div>
                <div className="rounded-md border border-slate-800 overflow-hidden max-h-64 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0">
                      <tr className="bg-slate-900/95 border-b border-slate-800">
                        <th className="text-left font-medium text-slate-400 px-2 py-1">Candle</th>
                        <th className="text-center font-medium text-slate-400 px-1 py-1">A1</th>
                        <th className="text-center font-medium text-slate-400 px-1 py-1">A2</th>
                        <th className="text-center font-medium text-slate-400 px-1 py-1">A3</th>
                        <th className="text-center font-medium text-slate-400 px-2 py-1">Consensus</th>
                        <th className="text-center font-medium text-slate-400 px-1 py-1">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candles.slice(0, 30).map((cnd: CandleConsensus) => {
                        // Compute the consensus outcome from the agreeing apps' outcomes.
                        // If any agreeing app's outcome is WIN/CORRECT → win.
                        // If any is LOSS/WRONG → loss. Else unknown.
                        const agreeing = cnd.signals.filter((s) =>
                          cnd.consensus.agreeingApps.includes(s.source)
                        );
                        const outcomes = agreeing
                          .map((s) => s.outcome)
                          .filter((o): o is NonNullable<typeof o> => o != null);
                        let outcomeLabel: string = "—";
                        let outcomeColor: string = "text-slate-500";
                        if (outcomes.length > 0) {
                          const hasWin = outcomes.some((o) => o === "WIN" || o === "CORRECT");
                          const hasLoss = outcomes.some((o) => o === "LOSS" || o === "WRONG");
                          if (hasWin && !hasLoss) {
                            outcomeLabel = "WIN";
                            outcomeColor = "text-emerald-400";
                          } else if (hasLoss && !hasWin) {
                            outcomeLabel = "LOSS";
                            outcomeColor = "text-rose-400";
                          } else if (hasWin && hasLoss) {
                            outcomeLabel = "MIXED";
                            outcomeColor = "text-amber-400";
                          } else {
                            outcomeLabel = "DRAW";
                            outcomeColor = "text-slate-400";
                          }
                        }
                        return (
                        <tr key={cnd.candleTime} className="border-b border-slate-800/40 last:border-0">
                          <td className="px-2 py-1 text-cyan-300 tabular-nums">
                            {fmtSigTime(cnd.candleTime)}
                          </td>
                          {(["app1", "app2", "app3"] as AppId[]).map((id) => {
                            const s = cnd.signals.find((x) => x.source === id);
                            return (
                              <td key={id} className="px-1 py-1 text-center">
                                {s ? (
                                  <span className={cn(
                                    "font-bold text-[10px]",
                                    s.direction === "CALL" ? "text-emerald-400" :
                                    s.direction === "PUT" ? "text-rose-400" : "text-slate-500"
                                  )}>
                                    {s.direction === "CALL" ? "▲" : s.direction === "PUT" ? "▼" : "—"}
                                  </span>
                                ) : (
                                  <span className="text-slate-700">·</span>
                                )}
                              </td>
                            );
                          })}
                          <td className="px-2 py-1 text-center">
                            <span className={cn(
                              "text-[10px] font-bold",
                              cnd.consensus.level === "3-agree" ? "text-emerald-300" :
                              cnd.consensus.level === "2-agree" ? "text-amber-300" :
                              cnd.consensus.level === "conflict" ? "text-rose-300" :
                              "text-slate-500"
                            )}>
                              {cnd.consensus.level === "3-agree" ? "3A" :
                               cnd.consensus.level === "2-agree" ? "2A" :
                               cnd.consensus.level === "conflict" ? "✗" :
                               cnd.consensus.level === "1-only" ? "1" : "—"}
                              {cnd.consensus.direction && cnd.consensus.direction !== "NEUTRAL" && (
                                <span className="ml-0.5">
                                  {cnd.consensus.direction === "CALL" ? "▲" : "▼"}
                                </span>
                              )}
                            </span>
                          </td>
                          <td className={cn("px-1 py-1 text-center text-[10px] font-bold", outcomeColor)}>
                            {outcomeLabel}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
