"use client"

import { Layers, CheckCircle2, Activity, AlertTriangle, TrendingUp } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Card } from "@/components/ui/card"
import type { AggregatedResponse } from "@/lib/signal-aggregator"
import { fmtClock } from "@/components/shared/format"
import { AppStatusCards } from "./app-status-cards"
import { SummaryStats } from "./summary-stats"
import { ConsensusHighlights } from "./consensus-highlights"

const POLL_INTERVAL_MS = 5_000

interface HomeTabProps {
  data: AggregatedResponse | null
  loading: boolean
}

/**
 * Home tab — the glanceable overview.
 *
 * Shows the 3 app status cards, the 5-card summary stats, the consensus
 * highlights (3-bot agree + 2-bot agree), and the freshness legend.
 */
export function HomeTab({ data, loading }: HomeTabProps) {
  if (loading && !data) {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl bg-slate-800/60" />
          ))}
        </div>
        <Skeleton className="h-24 rounded-xl bg-slate-800/60" />
        <Skeleton className="h-96 rounded-xl bg-slate-800/60" />
      </div>
    )
  }

  if (!data) return null

  return (
    <>
      <AppStatusCards apps={data.apps} />

      <SummaryStats
        totalPairs={data.summary.totalPairs}
        threeBotAgreeCount={data.summary.threeBotAgree.length}
        twoBotAgreeCount={data.summary.twoBotAgree.length}
        conflictCount={data.summary.conflicts.length}
        callCount={data.summary.pairsByDirection.CALL}
        putCount={data.summary.pairsByDirection.PUT}
      />

      {(data.summary.threeBotAgree.length > 0 || data.summary.twoBotAgree.length > 0) && (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ConsensusHighlights
            title="3 BOT AGREE — STRONG SIGNAL"
            pairs={data.summary.threeBotAgree}
            variant="emerald"
          />
          <ConsensusHighlights
            title="2 BOT AGREE — MEDIUM SIGNAL"
            pairs={data.summary.twoBotAgree}
            variant="amber"
          />
        </section>
      )}

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
  )
}
