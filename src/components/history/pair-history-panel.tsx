"use client"

import { useMemo } from "react"
import { X, Filter, History, CandlestickChart } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ConsensusLevel, PairStat, ClassifiedCluster } from "@/lib/backtest-runner"
import { DirectionPill } from "@/components/chart-signal/direction-pill"
import type { Direction } from "@/lib/signal-aggregator"
import { fmtSigTime } from "@/components/shared/format"
import { CandleChart } from "@/components/chart-signal/candle-chart"
import { useCandles } from "@/hooks/use-candles"

interface PairHistoryPanelProps {
  pairStat: PairStat
  levelFilter: ConsensusLevel | "all"
  onLevelFilterChange: (v: ConsensusLevel | "all") => void
  onClear: () => void
}

const LEVEL_OPTIONS: ReadonlyArray<[ConsensusLevel | "all", string]> = [
  ["all",       "All"],
  ["3-agree",   "3 App Agree"],
  ["2-agree",   "2 App Agree"],
  ["conflict",  "Conflict"],
  ["1-only",    "Single App"],
] as const

/**
 * Per-pair drill-down view. Shows:
 *   - The pair's win rate at each consensus level (with a filter to focus
 *     on one level).
 *   - A candle chart of the last ~60 candles for the pair, fetched live
 *     from App 3 via /api/candles.
 *   - The pair's full signal history table (candle time, direction,
 *     outcome, consensus level).
 *
 * The win/loss outcomes here are graded against actual candle close data
 * from App 3 — see lib/candle-fetcher.ts and lib/backtest-runner.ts for
 * the grading logic.
 */
export function PairHistoryPanel({
  pairStat, levelFilter, onLevelFilterChange, onClear,
}: PairHistoryPanelProps) {
  // Fetch candle history for this pair (client-side, polls every 5s).
  const { candles, loading: candlesLoading } = useCandles(pairStat.pair, 5000)

  // Filter the history by the selected level.
  const filteredHistory: ClassifiedCluster[] = useMemo(() => {
    if (levelFilter === "all") return pairStat.history
    return pairStat.history.filter((c) => c.level === levelFilter)
  }, [pairStat.history, levelFilter])

  // Find the most recent signal candle for the chart marker.
  const latestSignal = pairStat.history[0]
  const signalCandleTime = latestSignal?.ts ?? undefined
  const signalDirection: "CALL" | "PUT" | null =
    latestSignal?.direction === "CALL" || latestSignal?.direction === "PUT"
      ? latestSignal.direction
      : null

  const fmtPct = (n: number, d: number) => (d > 0 ? `${(n / d * 100).toFixed(1)}%` : "—")

  return (
    <Card className="border-emerald-500/30 bg-slate-900/50">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 flex items-center gap-2 flex-wrap">
        <CandlestickChart className="h-4 w-4 text-emerald-400" />
        <h2 className="text-sm font-bold tracking-wide text-slate-100">
          {pairStat.displayPair}
        </h2>
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
          {pairStat.category}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          className="ml-auto h-7 text-slate-400 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" /> Close
        </Button>
      </div>

      <div className="p-4 space-y-4">
        {/* Per-level win rate cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {(["3-agree", "2-agree", "conflict", "1-only"] as ConsensusLevel[]).map((lvl) => {
            const s = pairStat.levels[lvl]
            const graded = s.win + s.loss
            const wr = graded > 0 ? (s.win / graded * 100) : 0
            const tone =
              lvl === "3-agree" ? "emerald" :
              lvl === "2-agree" ? "amber" :
              lvl === "conflict" ? "rose" : "slate"
            const toneCls = {
              emerald: "border-emerald-500/30 bg-emerald-500/5",
              amber:   "border-amber-500/30 bg-amber-500/5",
              rose:    "border-rose-500/30 bg-rose-500/5",
              slate:   "border-slate-700 bg-slate-800/30",
            }[tone]
            const dimmed = levelFilter !== "all" && levelFilter !== lvl
            return (
              <div
                key={lvl}
                className={cn(
                  "rounded-lg border p-2.5 transition-opacity",
                  toneCls,
                  dimmed && "opacity-30"
                )}
              >
                <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
                  {lvl === "3-agree" ? "3 APP AGREE" :
                   lvl === "2-agree" ? "2 APP AGREE" :
                   lvl === "conflict" ? "CONFLICT" : "SINGLE APP"}
                </div>
                <div className="mt-0.5 text-xl font-bold tabular-nums text-slate-100">
                  {graded > 0 ? `${wr.toFixed(1)}%` : "—"}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                  {s.win}W / {s.loss}L{s.draw > 0 ? ` / ${s.draw}D` : ""} / {s.unknown}?
                </div>
              </div>
            )
          })}
        </div>

        {/* Level filter */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="h-3.5 w-3.5 text-slate-500" />
          <span className="text-[11px] text-slate-400 mr-1">Filter history:</span>
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
          <span className="ml-auto text-[11px] text-slate-500 tabular-nums">
            {filteredHistory.length} / {pairStat.history.length} signals
          </span>
        </div>

        {/* Candle chart */}
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
            <CandlestickChart className="h-3.5 w-3.5 text-cyan-400" /> Candle Chart (last 30 candles, UTC)
          </div>
          {candlesLoading && candles.length === 0 ? (
            <div className="h-[180px] rounded-md border border-slate-800 bg-slate-950/40 flex items-center justify-center text-[11px] text-slate-500">
              Loading candle data…
            </div>
          ) : (
            <CandleChart
              candles={candles}
              signalCandleTime={signalCandleTime}
              signalDirection={signalDirection}
              maxBars={30}
              height={180}
            />
          )}
          <div className="text-[10px] text-slate-500 mt-1">
            Live OHLC from App 3 · green = bullish · red = bearish ·
            triangle marks the latest signal candle
          </div>
        </div>

        {/* Signal history table */}
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
            <History className="h-3.5 w-3.5 text-amber-400" /> Signal History
          </div>
          <div className="rounded-md border border-slate-800 overflow-hidden max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0">
                <tr className="bg-slate-900/95 border-b border-slate-800">
                  <th className="text-left font-medium text-slate-400 px-2 py-1.5">Candle (UTC)</th>
                  <th className="text-center font-medium text-slate-400 px-1 py-1.5">Apps</th>
                  <th className="text-center font-medium text-slate-400 px-2 py-1.5">Consensus</th>
                  <th className="text-center font-medium text-slate-400 px-2 py-1.5">Direction</th>
                  <th className="text-center font-medium text-slate-400 px-2 py-1.5">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2 py-6 text-center text-slate-500">
                      No signals match the current filter.
                    </td>
                  </tr>
                )}
                {filteredHistory.slice(0, 100).map((c) => {
                  const lvlLabel = c.level === "3-agree" ? "3A" :
                    c.level === "2-agree" ? "2A" :
                    c.level === "conflict" ? "✗" : "1"
                  const lvlColor = c.level === "3-agree" ? "text-emerald-300" :
                    c.level === "2-agree" ? "text-amber-300" :
                    c.level === "conflict" ? "text-rose-300" : "text-slate-400"
                  return (
                    <tr key={`${c.pair}-${c.ts}`} className="border-b border-slate-800/40 last:border-0">
                      <td className="px-2 py-1.5 text-cyan-300 tabular-nums">{fmtSigTime(c.ts)}</td>
                      <td className="px-1 py-1.5 text-center text-slate-400 tabular-nums">{c.nApps}</td>
                      <td className={cn("px-2 py-1.5 text-center font-bold text-[10px]", lvlColor)}>
                        {lvlLabel}
                        {c.direction && (
                          <span className="ml-0.5">
                            {c.direction === "CALL" ? "▲" : "▼"}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {c.direction && <DirectionPill dir={c.direction as Direction} size="sm" />}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {c.outcome === null ? (
                          <span className="text-[10px] text-slate-500">—</span>
                        ) : c.outcome === 1 ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">WIN</span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300">LOSS</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Card>
  )
}
