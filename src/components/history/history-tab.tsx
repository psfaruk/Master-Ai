"use client"

import { useMemo, useState } from "react"
import type { BacktestResult, ConsensusLevel, PairStat } from "@/lib/backtest-runner"
import { BacktestPanel } from "./backtest-panel"
import { PairHistoryPanel } from "./pair-history-panel"

interface HistoryTabProps {
  backtest: BacktestResult | null
  backtestLoading: boolean
  backtestError: string | null
  onRunBacktest: () => void
}

/**
 * History tab.
 *
 * Two views:
 *   1. Global backtest (default) — overall win rate by consensus level
 *      (3-agree / 2-agree / conflict / 1-only).
 *   2. Per-pair history (when a pair is selected) — that pair's win rate
 *      broken down by consensus level, its candle chart, and its full
 *      signal history table.
 *
 * The user can filter the per-pair view by consensus level too — useful
 * for answering questions like "show me only the 2-agree signals for
 * USDCOP_otc and their win rate".
 *
 * A separate "win-rate by level" filter at the top lets the user see the
 * aggregated win rate across ALL pairs for just one consensus level
 * (2-agree vs 3-agree).
 */
export function HistoryTab({
  backtest, backtestLoading, backtestError, onRunBacktest,
}: HistoryTabProps) {
  // Filter for the aggregated view: "all" shows every level's stats,
  // selecting a level restricts the global stats table to just that level.
  const [globalLevelFilter, setGlobalLevelFilter] = useState<ConsensusLevel | "all">("all")
  // Selected pair — null shows the global view; a pair shows its detail.
  const [selectedPair, setSelectedPair] = useState<string | null>(null)
  // Per-pair level filter — only applies inside the per-pair view.
  const [pairLevelFilter, setPairLevelFilter] = useState<ConsensusLevel | "all">("all")

  // The currently selected pair's stats object (if any).
  const selectedPairStat: PairStat | null = useMemo(() => {
    if (!backtest || !selectedPair) return null
    return backtest.perPair.find((p) => p.pair === selectedPair) ?? null
  }, [backtest, selectedPair])

  return (
    <section className="space-y-4">
      <BacktestPanel
        result={backtest}
        loading={backtestLoading}
        error={backtestError}
        onRun={onRunBacktest}
        levelFilter={globalLevelFilter}
        onLevelFilterChange={setGlobalLevelFilter}
        onSelectPair={setSelectedPair}
        selectedPair={selectedPair}
      />

      {selectedPairStat && (
        <PairHistoryPanel
          pairStat={selectedPairStat}
          levelFilter={pairLevelFilter}
          onLevelFilterChange={setPairLevelFilter}
          onClear={() => setSelectedPair(null)}
        />
      )}
    </section>
  )
}
