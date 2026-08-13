"use client"

import { Beaker, BarChart3, RefreshCw, AlertTriangle } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { BacktestResult, ConsensusLevel, PairStat } from "@/lib/backtest-runner"
import { BacktestContent } from "./backtest-content"

interface BacktestPanelProps {
  result: BacktestResult | null
  loading: boolean
  error: string | null
  onRun: () => void
  /** Filter for the aggregated view: a specific level, or "all". */
  levelFilter: ConsensusLevel | "all"
  onLevelFilterChange: (v: ConsensusLevel | "all") => void
  /** Called when the user picks a pair to drill into. */
  onSelectPair: (pair: string) => void
  /** Currently-selected pair (null = no pair selected). */
  selectedPair: string | null
}

const LEVEL_OPTIONS: ReadonlyArray<[ConsensusLevel | "all", string]> = [
  ["all",       "All Levels"],
  ["3-agree",   "3 App Agree"],
  ["2-agree",   "2 App Agree"],
  ["conflict",  "Conflict"],
  ["1-only",    "Single App"],
] as const

/** The card that wraps the backtest result, with a "Run Backtest" button. */
export function BacktestPanel({
  result, loading, error, onRun,
  levelFilter, onLevelFilterChange,
  onSelectPair, selectedPair,
}: BacktestPanelProps) {
  return (
    <Card className="border-slate-800 bg-slate-900/50">
      <div className="p-4 border-b border-slate-800 flex items-center gap-2 flex-wrap">
        <Beaker className="h-4 w-4 text-cyan-400" />
        <h2 className="text-sm font-bold tracking-wide text-slate-100">
          Backtest Verification
        </h2>
        <span className="text-[11px] text-slate-500">
          Live cross-source accuracy check · UTC
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={onRun}
          disabled={loading}
          className="ml-auto h-7 border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200"
        >
          {loading ? (
            <><RefreshCw className="h-3 w-3 animate-spin" /> Running...</>
          ) : (
            <><BarChart3 className="h-3 w-3" /> Run Backtest</>
          )}
        </Button>
      </div>

      {/* Level filter — 2-app vs 3-app agree win rates */}
      <div className="px-4 py-2 border-b border-slate-800/60 flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] text-slate-400 mr-1">Filter:</span>
        {LEVEL_OPTIONS.map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant="ghost"
            onClick={() => onLevelFilterChange(key)}
            aria-pressed={levelFilter === key}
            className={cn(
              "h-6 px-2 text-[11px]",
              levelFilter === key
                ? "bg-slate-700 text-white hover:bg-slate-700"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            )}
          >
            {label}
          </Button>
        ))}
        {selectedPair && (
          <span className="ml-auto text-[11px] text-emerald-300">
            Showing pair detail below
          </span>
        )}
      </div>

      <div className="p-4">
        {error && (
          <div className="mb-3 p-2.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-200 text-xs flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </div>
        )}

        {!result && !loading && !error && (
          <div className="text-sm text-slate-400 py-6 text-center">
            Click <strong className="text-slate-200">Run Backtest</strong> to fetch historical signals from all 3 apps and verify the consensus logic with real win/loss data.
          </div>
        )}

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-20 rounded-md bg-slate-800/60" />
            <Skeleton className="h-40 rounded-md bg-slate-800/60" />
          </div>
        )}

        {result && !loading && (
          <BacktestContent
            result={result}
            levelFilter={levelFilter}
            onSelectPair={onSelectPair}
            selectedPair={selectedPair}
          />
        )}
      </div>
    </Card>
  )
}

// Re-export PairStat type so consumers can import it from this module if
// they want to (otherwise it's only used inside BacktestContent's props).
export type { PairStat }
