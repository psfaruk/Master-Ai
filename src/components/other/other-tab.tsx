"use client"

import { useEffect, useState } from "react"
import {
  Activity, ExternalLink, Database, Server, Clock, AlertCircle,
} from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { AggregatedResponse } from "@/lib/signal-aggregator"

interface DiagApp2Cache {
  running: boolean
  lastPollAt: number
  lastPollAgeMs: number
  lastPollOk: boolean
  lastError: string | null
  lastRawCount: number
  lastSkipped: { noPair: number; neutral: number }
  pairs: number
  entries: number
}

interface DiagResponse {
  now: { unixSec: number; currentCandle: number; iso: string }
  apps: Array<{
    app: string
    health: string
    error: string | null
    rawRows: number
    normalizedSignals: number
    candleOffsetApplied: number
    distinctPairs: string[]
    newestCandleLagCandles: number | null
    signalsInLast5Candles: number
    validForOwnCandle: number
    invalidForOwnCandle: number
  }>
  app2Cache: DiagApp2Cache
  candleCoverageLast30Candles: {
    oneApp: number
    twoApps: number
    threeApps: number
    buckets: number
  }
}

interface OtherTabProps {
  data: AggregatedResponse | null
  isLive: boolean
  fastPoller: boolean
  wsConnected: boolean
  lastUpdated: number
}

/**
 * Other tab — diagnostics & system info.
 *
 * Fetches /api/diag on mount and renders a compact summary plus quick links
 * to every API endpoint. This is the "what's going on under the hood" tab.
 */
export function OtherTab({ data, isLive, fastPoller, wsConnected, lastUpdated }: OtherTabProps) {
  const [diag, setDiag] = useState<DiagResponse | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagError, setDiagError] = useState<string | null>(null)

  const fetchDiag = async () => {
    setDiagLoading(true)
    setDiagError(null)
    try {
      const res = await fetch("/api/diag", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: DiagResponse = await res.json()
      setDiag(json)
    } catch (e: any) {
      setDiagError(e?.message ?? "Failed to fetch diagnostics")
    } finally {
      setDiagLoading(false)
    }
  }

  useEffect(() => {
    void fetchDiag()
  }, [])

  return (
    <div className="space-y-4">
      {/* System status */}
      <Card className="border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Server className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-bold tracking-wide text-slate-100">System Status</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <StatusCell label="Data flow" value={isLive ? "LIVE" : "POLL"} tone={isLive ? "emerald" : "amber"} />
          <StatusCell label="Fast poller" value={fastPoller ? "ON (5s cache)" : "OFF (slow)"} tone={fastPoller ? "emerald" : "slate"} />
          <StatusCell label="WebSocket" value={wsConnected ? "CONNECTED" : "DISCONNECTED"} tone={wsConnected ? "emerald" : "slate"} />
          <StatusCell
            label="Last update"
            value={lastUpdated > 0 ? new Date(lastUpdated).toLocaleTimeString("en-GB", { hour12: false }) : "—"}
            tone="slate"
          />
        </div>
      </Card>

      {/* Quick links */}
      <Card className="border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <ExternalLink className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-bold tracking-wide text-slate-100">API Endpoints</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {[
            { url: "/api/snapshot?refresh=1", desc: "Force re-poll + return latest cached snapshot" },
            { url: "/api/aggregated",          desc: "Direct aggregated fetch (no cache)" },
            { url: "/api/backtest",            desc: "Run candle-aligned backtest, return win rates" },
            { url: "/api/diag",                desc: "Alignment diagnostics per app" },
          ].map(({ url, desc }) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-slate-800 bg-slate-950/40 p-2.5 hover:border-slate-700 transition-colors block"
            >
              <div className="text-xs font-mono text-cyan-300">{url}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">{desc}</div>
            </a>
          ))}
        </div>
      </Card>

      {/* Diagnostics */}
      <Card className="border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-bold tracking-wide text-slate-100">Diagnostics</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void fetchDiag()}
            disabled={diagLoading}
            className="ml-auto h-7 border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200"
          >
            Refresh
          </Button>
        </div>

        {diagError && (
          <div className="mb-3 p-2.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 text-xs flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5" /> {diagError}
          </div>
        )}

        {diagLoading && !diag && (
          <Skeleton className="h-40 rounded-md bg-slate-800/60" />
        )}

        {diag && (
          <div className="space-y-3">
            {/* Per-app summary */}
            <div>
              <div className="text-xs font-semibold text-slate-300 mb-2">Per-App Summary</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {diag.apps.map((a) => (
                  <div key={a.app} className="rounded-md border border-slate-800 bg-slate-950/40 p-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200">{a.app}</span>
                      <span className={cn(
                        "text-[10px] font-bold px-1.5 py-0.5 rounded",
                        a.health === "ok" || a.health === "live"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : a.health === "down"
                          ? "bg-rose-500/20 text-rose-300"
                          : "bg-amber-500/20 text-amber-300"
                      )}>
                        {a.health.toUpperCase()}
                      </span>
                    </div>
                    <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-400">
                      <div className="flex justify-between"><span>Raw rows</span><span className="tabular-nums text-slate-300">{a.rawRows}</span></div>
                      <div className="flex justify-between"><span>Normalized</span><span className="tabular-nums text-slate-300">{a.normalizedSignals}</span></div>
                      <div className="flex justify-between"><span>Distinct pairs</span><span className="tabular-nums text-slate-300">{a.distinctPairs.length}</span></div>
                      <div className="flex justify-between"><span>Valid for candle</span><span className="tabular-nums text-emerald-300">{a.validForOwnCandle}</span></div>
                      <div className="flex justify-between"><span>Invalid (late)</span><span className="tabular-nums text-amber-300">{a.invalidForOwnCandle}</span></div>
                      {a.newestCandleLagCandles !== null && (
                        <div className="flex justify-between"><span>Lag (candles)</span><span className="tabular-nums text-slate-300">{a.newestCandleLagCandles}</span></div>
                      )}
                    </div>
                    {a.error && (
                      <div className="mt-1.5 text-[10px] text-rose-300/80 truncate" title={a.error}>
                        {a.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* App 2 cache */}
            <div>
              <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                <Database className="h-3.5 w-3.5 text-violet-400" /> App 2 History Cache
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <CacheCell label="Running"   value={diag.app2Cache.running ? "YES" : "NO"} />
                <CacheCell label="Pairs"     value={String(diag.app2Cache.pairs)} />
                <CacheCell label="Entries"   value={String(diag.app2Cache.entries)} />
                <CacheCell label="Last raw"  value={String(diag.app2Cache.lastRawCount)} />
                <CacheCell label="Skipped (no pair)"   value={String(diag.app2Cache.lastSkipped.noPair)} />
                <CacheCell label="Skipped (neutral)"   value={String(diag.app2Cache.lastSkipped.neutral)} />
                <CacheCell
                  label="Last poll"
                  value={diag.app2Cache.lastPollAt > 0
                    ? new Date(diag.app2Cache.lastPollAt).toLocaleTimeString("en-GB", { hour12: false })
                    : "—"}
                />
                <CacheCell label="Last status" value={diag.app2Cache.lastPollOk ? "OK" : "FAIL"} tone={diag.app2Cache.lastPollOk ? "emerald" : "rose"} />
              </div>
              {diag.app2Cache.lastError && (
                <div className="mt-2 text-[11px] text-rose-300/80">Last error: {diag.app2Cache.lastError}</div>
              )}
            </div>

            {/* Candle coverage */}
            <div>
              <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-cyan-400" /> Candle Coverage (last 30 candles)
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <CacheCell label="1-app buckets"   value={String(diag.candleCoverageLast30Candles.oneApp)} />
                <CacheCell label="2-app buckets"   value={String(diag.candleCoverageLast30Candles.twoApps)} />
                <CacheCell label="3-app buckets"   value={String(diag.candleCoverageLast30Candles.threeApps)} />
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function StatusCell({ label, value, tone }: { label: string; value: string; tone: "emerald" | "amber" | "slate" }) {
  const tones = {
    emerald: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
    amber:   "border-amber-500/30 bg-amber-500/5 text-amber-300",
    slate:   "border-slate-700 bg-slate-800/30 text-slate-300",
  }[tone]
  return (
    <div className={cn("rounded-md border p-2.5", tones)}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  )
}

function CacheCell({ label, value, tone = "slate" }: { label: string; value: string; tone?: "emerald" | "rose" | "slate" }) {
  const tones = {
    emerald: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
    rose:    "border-rose-500/30 bg-rose-500/5 text-rose-300",
    slate:   "border-slate-700 bg-slate-800/30 text-slate-300",
  }[tone]
  return (
    <div className={cn("rounded-md border p-2.5", tones)}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  )
}
