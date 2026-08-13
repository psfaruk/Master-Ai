"use client"

import { Beaker, BarChart3, RefreshCw, AlertTriangle } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { BacktestResult } from "@/lib/backtest-runner"
import { BacktestContent } from "./backtest-content"

interface BacktestPanelProps {
  result: BacktestResult | null
  loading: boolean
  error: string | null
  onRun: () => void
}

/** The card that wraps the backtest result, with a "Run Backtest" button. */
export function BacktestPanel({ result, loading, error, onRun }: BacktestPanelProps) {
  return (
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

        {result && !loading && <BacktestContent result={result} />}
      </div>
    </Card>
  )
}
