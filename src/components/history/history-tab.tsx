"use client"

import type { BacktestResult } from "@/lib/backtest-runner"
import { BacktestPanel } from "./backtest-panel"

interface HistoryTabProps {
  backtest: BacktestResult | null
  backtestLoading: boolean
  backtestError: string | null
  onRunBacktest: () => void
}

/**
 * History tab — the backtest verification panel.
 *
 * Auto-runs 5s after mount and every 2 minutes (see useBacktest), but the
 * user can also trigger a manual run via the button.
 */
export function HistoryTab({
  backtest, backtestLoading, backtestError, onRunBacktest,
}: HistoryTabProps) {
  return (
    <section>
      <BacktestPanel
        result={backtest}
        loading={backtestLoading}
        error={backtestError}
        onRun={onRunBacktest}
      />
    </section>
  )
}
