"use client"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { PairConsensus } from "@/lib/signal-aggregator"
import { DirectionPill } from "@/components/chart-signal/direction-pill"

const STYLES = {
  emerald: {
    card:  "border-emerald-500/40 bg-gradient-to-br from-emerald-950/60 to-slate-900/40",
    title: "text-emerald-300",
    glow:  "shadow-emerald-500/10",
    row:   "border-emerald-500/30 bg-emerald-500/5",
  },
  amber: {
    card:  "border-amber-500/40 bg-gradient-to-br from-amber-950/60 to-slate-900/40",
    title: "text-amber-300",
    glow:  "shadow-amber-500/10",
    row:   "border-amber-500/30 bg-amber-500/5",
  },
} as const

/** A highlighted "3 BOT AGREE" or "2 BOT AGREE" panel listing matching pairs. */
export function ConsensusHighlights({
  title, pairs, variant,
}: {
  title: string
  pairs: PairConsensus[]
  variant: "emerald" | "amber"
}) {
  const s = STYLES[variant]

  return (
    <Card className={cn("p-4 border shadow-lg", s.card, s.glow)}>
      <div className="flex items-center gap-2 mb-3">
        <div
          className={cn(
            "h-2 w-2 rounded-full",
            variant === "emerald" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
          )}
        />
        <h2 className={cn("text-sm font-bold tracking-wide", s.title)}>{title}</h2>
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
                s.row
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
