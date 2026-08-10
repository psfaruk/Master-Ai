'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity, ArrowDownCircle, ArrowUpCircle, Bot, Clock, Filter, Github,
  MinusCircle, Pause, Play, Radio, RefreshCw, TrendingDown, TrendingUp,
  Wifi, WifiOff, AlertTriangle, CheckCircle2, XCircle, Layers,
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

const POLL_INTERVAL_MS = 15_000

// ---- helpers --------------------------------------------------------------

function fmtAgo(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

function fmtClock(ms: number): string {
  if (!ms) return "--:--:--"
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false })
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

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setIsRefreshing(true)
    try {
      const res = await fetch("/api/aggregated", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: AggregatedResponse = await res.json()
      setData(json)
      setLastUpdated(Date.now())
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? "Failed to fetch aggregated signals")
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (autoRefresh) {
      timerRef.current = setInterval(() => fetchData(true), POLL_INTERVAL_MS)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [autoRefresh, fetchData])

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
            <div className="flex items-center gap-1.5 text-xs text-slate-400 mr-1">
              <Clock className="h-3.5 w-3.5" />
              <span className="tabular-nums">{lastUpdated ? fmtClock(lastUpdated) : "--:--:--"}</span>
            </div>
            <div className="h-4 w-px bg-slate-700" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchData()}
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
  const accentColor =
    app.id === "app1" ? "amber" : app.id === "app2" ? "violet" : "emerald"

  return (
    <Card
      className={cn(
        "p-4 border bg-slate-900/60 relative overflow-hidden",
        isOnline ? "border-slate-800" : "border-rose-500/30"
      )}
    >
      <div
        className={cn(
          "absolute top-0 left-0 right-0 h-0.5",
          app.id === "app1" && "bg-amber-500",
          app.id === "app2" && "bg-violet-500",
          app.id === "app3" && "bg-emerald-500",
          !isOnline && "bg-rose-500"
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              "h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0",
              app.id === "app1" && "bg-amber-500/15 text-amber-400",
              app.id === "app2" && "bg-violet-500/15 text-violet-400",
              app.id === "app3" && "bg-emerald-500/15 text-emerald-400",
              !isOnline && "bg-rose-500/15 text-rose-400"
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
        <div className="flex items-center gap-1 flex-shrink-0">
          {isOnline && !tokenIssue ? (
            <Wifi className="h-4 w-4 text-emerald-400" />
          ) : (
            <WifiOff className="h-4 w-4 text-rose-400" />
          )}
          <span
            className={cn(
              "text-[10px] font-medium",
              isOnline && !tokenIssue ? "text-emerald-400" : "text-rose-400"
            )}
          >
            {isOnline ? (tokenIssue ? "TOKEN" : "ONLINE") : "OFFLINE"}
          </span>
        </div>
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
          <div className="text-slate-200 font-semibold tabular-nums">
            {app.freshSignalCount}
          </div>
        </div>
      </div>

      {app.error && (
        <div className="mt-2 text-[10px] text-rose-300/80 truncate" title={app.error}>
          Error: {app.error}
        </div>
      )}
      {tokenIssue && (
        <div className="mt-2 text-[10px] text-amber-300/80 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" /> Token expired on source app
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

function PairRow({ pair }: { pair: PairConsensus }) {
  const [expanded, setExpanded] = useState(false)
  const c = pair.consensus
  const meta = CONSENSUS_META[c.level]

  const getSignal = (id: AppId): SourceSignal | undefined =>
    pair.signals.find((s) => s.source === id)

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
          <div className="font-medium text-slate-100">{pair.displayPair}</div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">
            {pair.category}
          </div>
        </td>
        {(["app1", "app2", "app3"] as AppId[]).map((id) => {
          const sig = getSignal(id)
          return (
            <td key={id} className="px-2 py-2.5 text-center">
              {sig ? <DirectionPill dir={sig.direction} size="sm" /> : (
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
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
                        No signal from this app for this pair.
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
