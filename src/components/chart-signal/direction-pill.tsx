"use client"

import { TrendingUp, TrendingDown, MinusCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Direction } from "@/lib/signal-aggregator"

/**
 * The CALL / PUT / — pill used throughout the dashboard. Two sizes: "sm" for
 * table cells, "md" for highlights and detail panels.
 */
export function DirectionPill({
  dir,
  size = "md",
}: {
  dir: Direction | null
  size?: "sm" | "md"
}) {
  const sz = size === "sm" ? "h-6 px-2 text-[11px]" : "h-8 px-3 text-sm"

  if (dir === "CALL") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md font-bold tracking-wide",
          "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
          sz
        )}
      >
        <TrendingUp className="h-3.5 w-3.5" /> CALL
      </span>
    )
  }
  if (dir === "PUT") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md font-bold tracking-wide",
          "bg-rose-500/20 text-rose-300 border border-rose-500/40",
          sz
        )}
      >
        <TrendingDown className="h-3.5 w-3.5" /> PUT
      </span>
    )
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md font-medium tracking-wide",
        "bg-slate-700/40 text-slate-400 border border-slate-700/40",
        sz
      )}
    >
      <MinusCircle className="h-3.5 w-3.5" /> —
    </span>
  )
}
