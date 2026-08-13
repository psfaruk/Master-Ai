"use client"

import {
  Clock, RefreshCw, Play, Pause, Zap, Radio,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { fmtClock, fmtClockSec } from "@/components/shared/format"

interface HeaderBarProps {
  /** Wall clock in ms — rAF-throttled, updates ~20Hz for smooth ms display. */
  nowMs: number
  lastUpdated: number
  isLive: boolean
  wsConnected: boolean
  fastPoller: boolean
  isRefreshing: boolean
  autoRefresh: boolean
  onRefresh: () => void
  onToggleAutoRefresh: (v: boolean) => void
}

/**
 * The top sticky header. Same on mobile and desktop — only its layout
 * density changes via flex-wrap.
 *
 * The wall clock displays UTC with millisecond precision and updates at
 * ~20Hz (the precise-clock hook ties updates to rAF so we never re-render
 * more often than the browser can paint). A "UTC" chip is shown next to
 * the clock so there is no ambiguity about which timezone the displayed
 * time refers to.
 */
export function HeaderBar({
  nowMs, lastUpdated, isLive, wsConnected, fastPoller,
  isRefreshing, autoRefresh, onRefresh, onToggleAutoRefresh,
}: HeaderBarProps) {
  const liveTitle = isLive
    ? (wsConnected
        ? "Real-time WebSocket connected"
        : fastPoller
        ? "Live data via adaptive poller (fast after candle open)"
        : "Receiving live data via polling")
    : "No recent data — check connection"

  return (
    <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur supports-[backdrop-filter]:bg-slate-950/70">
      <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap items-center gap-3">
        {/* Logo + title */}
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

        {/* Right-side controls */}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {/* LIVE / POLL indicator */}
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 h-8 rounded-md border text-xs",
              isLive
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300"
            )}
            title={liveTitle}
          >
            {isLive ? (
              <><Zap className="h-3 w-3" /> LIVE</>
            ) : (
              <><RefreshCw className="h-3 w-3 animate-pulse" /> POLL</>
            )}
          </div>

          {/* Wall clock — UTC with milliseconds */}
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mr-1">
            <Clock className="h-3.5 w-3.5" />
            <span className="tabular-nums text-slate-200 font-semibold text-[13px]">
              {fmtClock(nowMs)}
            </span>
            <span
              className="text-[9px] font-bold tracking-wider px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
              title="All times in this dashboard are displayed in UTC"
            >
              UTC
            </span>
            {lastUpdated > 0 && (
              <span className="text-slate-500 ml-1 tabular-nums" title="Last data update (UTC)">
                ·data {fmtClockSec(lastUpdated)}
              </span>
            )}
          </div>

          <div className="h-4 w-px bg-slate-700" />

          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
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
              onCheckedChange={onToggleAutoRefresh}
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
  )
}
