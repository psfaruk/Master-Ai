"use client"

import {
  CheckCircle2, AlertTriangle, XCircle, Trophy, Target, ChevronRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { AppId } from "@/lib/signal-aggregator"
import type {
  BacktestResult, ConsensusLevel as BtLevel, PairStat,
} from "@/lib/backtest-runner"
import { DirectionPill } from "@/components/chart-signal/direction-pill"
import type { Direction } from "@/lib/signal-aggregator"
import { fmtSigTime } from "@/components/shared/format"

interface BacktestContentProps {
  result: BacktestResult
  /** Filter for the aggregated view: a specific level, or "all". */
  levelFilter: BtLevel | "all"
  /** Called when the user picks a pair to drill into. */
  onSelectPair: (pair: string) => void
  /** Currently-selected pair (null = no pair selected). */
  selectedPair: string | null
}

/** Renders the structured result of a backtest run. */
export function BacktestContent({
  result, levelFilter, onSelectPair, selectedPair,
}: BacktestContentProps) {
  const levels: BtLevel[] = ["3-agree", "2-agree", "conflict", "1-only"]

  const verdictIcon = {
    validated:    <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
    partial:      <AlertTriangle className="h-4 w-4 text-amber-400" />,
    anomaly:      <XCircle className="h-4 w-4 text-rose-400" />,
    insufficient: <AlertTriangle className="h-4 w-4 text-slate-400" />,
  }[result.verdict.kind]

  const verdictTone = {
    validated:    "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    partial:      "border-amber-500/40 bg-amber-500/10 text-amber-200",
    anomaly:      "border-rose-500/40 bg-rose-500/10 text-rose-200",
    insufficient: "border-slate-700 bg-slate-800/40 text-slate-300",
  }[result.verdict.kind]

  return (
    <div className="space-y-4">
      {/* Verdict banner */}
      <div className={cn("rounded-lg border p-3 flex items-start gap-2.5", verdictTone)}>
        <div className="mt-0.5 flex-shrink-0">{verdictIcon}</div>
        <div className="min-w-0">
          <div className="text-sm font-semibold capitalize">
            {result.verdict.kind === "validated"    && "Consensus Logic Validated"}
            {result.verdict.kind === "partial"      && "Partial Validation"}
            {result.verdict.kind === "anomaly"      && "Anomaly Detected"}
            {result.verdict.kind === "insufficient" && "Insufficient Graded Data"}
          </div>
          <div className="text-xs opacity-90 mt-0.5">{result.verdict.message}</div>
        </div>
      </div>

      {/* Stats grid — dim non-matching levels when a filter is active */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {levels.map((lvl) => {
          const s = result.levels[lvl]
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
                "rounded-lg border p-3 transition-opacity",
                toneCls,
                dimmed && "opacity-30"
              )}
            >
              <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
                {lvl === "3-agree" ? "3 APP AGREE" :
                 lvl === "2-agree" ? "2 APP AGREE" :
                 lvl === "conflict" ? "CONFLICT" : "SINGLE APP"}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums text-slate-100">
                {graded > 0 ? `${wr.toFixed(1)}%` : "—"}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                {s.win}W / {s.loss}L{s.draw > 0 ? ` / ${s.draw}D` : ""} / {s.unknown}?  · {s.total} total
              </div>
            </div>
          )
        })}
      </div>

      {/* Source app accuracy */}
      <div>
        <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
          <Trophy className="h-3.5 w-3.5 text-amber-400" /> Source App Individual Accuracy
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {(["app1", "app2", "app3"] as AppId[]).map((id) => {
            const s = result.sources[id]
            const graded = s.win + s.loss
            const wr = graded > 0 ? (s.win / graded * 100) : 0
            const name = id === "app1" ? "App 1 · Minimum Pair" :
                         id === "app2" ? "App 2 · Binary Term" : "App 3 · OTC Live"
            return (
              <div key={id} className="rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
                <div className="text-[11px] text-slate-400">{name}</div>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-lg font-bold tabular-nums text-slate-100">
                    {graded > 0 ? `${wr.toFixed(1)}%` : "—"}
                  </span>
                  <span className="text-[10px] text-slate-500 tabular-nums">
                    {s.win}W / {s.loss}L{s.draw > 0 ? ` / ${s.draw}D` : ""} / {s.unknown}?
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{s.total} total signals</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Per-pair win rates — clickable to drill into pair detail */}
      <div>
        <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
          <Target className="h-3.5 w-3.5 text-cyan-400" /> Per-Pair Win Rate
          <span className="text-[10px] text-slate-500 ml-1">(click a pair for full history)</span>
        </div>
        <div className="rounded-md border border-slate-800 overflow-hidden max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0">
              <tr className="bg-slate-900/95 border-b border-slate-800">
                <th className="text-left font-medium text-slate-400 px-3 py-1.5">Pair</th>
                <th className="text-center font-medium text-slate-400 px-2 py-1.5">3-app agree</th>
                <th className="text-center font-medium text-slate-400 px-2 py-1.5">2-app agree</th>
                <th className="text-center font-medium text-slate-400 px-2 py-1.5">1-app only</th>
                <th className="text-center font-medium text-slate-400 px-2 py-1.5">Total</th>
                <th className="text-right font-medium text-slate-400 px-3 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {result.perPair.map((p) => {
                const g3 = p.levels["3-agree"].win + p.levels["3-agree"].loss
                const g2 = p.levels["2-agree"].win + p.levels["2-agree"].loss
                const g1 = p.levels["1-only"].win + p.levels["1-only"].loss
                const wr3 = g3 > 0 ? (p.levels["3-agree"].win / g3 * 100) : null
                const wr2 = g2 > 0 ? (p.levels["2-agree"].win / g2 * 100) : null
                const wr1 = g1 > 0 ? (p.levels["1-only"].win / g1 * 100) : null
                const total = p.levels["3-agree"].total + p.levels["2-agree"].total + p.levels["1-only"].total
                const isActive = selectedPair === p.pair
                return (
                  <tr
                    key={p.pair}
                    onClick={() => onSelectPair(p.pair)}
                    className={cn(
                      "border-b border-slate-800/40 last:border-0 cursor-pointer hover:bg-slate-800/40 transition-colors",
                      isActive && "bg-emerald-500/10"
                    )}
                  >
                    <td className="px-3 py-1.5">
                      <div className="text-slate-200 font-medium">{p.displayPair}</div>
                      <div className="text-[10px] text-slate-500 uppercase">{p.category}</div>
                    </td>
                    <td className="px-2 py-1.5 text-center tabular-nums">
                      <span className={cn(
                        "font-bold",
                        wr3 === null ? "text-slate-600" : wr3 >= 60 ? "text-emerald-300" : wr3 >= 40 ? "text-amber-300" : "text-rose-300"
                      )}>
                        {wr3 === null ? "—" : `${wr3.toFixed(0)}%`}
                      </span>
                      <div className="text-[9px] text-slate-500">
                        {p.levels["3-agree"].win}/{g3}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-center tabular-nums">
                      <span className={cn(
                        "font-bold",
                        wr2 === null ? "text-slate-600" : wr2 >= 60 ? "text-emerald-300" : wr2 >= 40 ? "text-amber-300" : "text-rose-300"
                      )}>
                        {wr2 === null ? "—" : `${wr2.toFixed(0)}%`}
                      </span>
                      <div className="text-[9px] text-slate-500">
                        {p.levels["2-agree"].win}/{g2}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-center tabular-nums">
                      <span className={cn(
                        "font-bold",
                        wr1 === null ? "text-slate-600" : wr1 >= 60 ? "text-emerald-300" : wr1 >= 40 ? "text-amber-300" : "text-rose-300"
                      )}>
                        {wr1 === null ? "—" : `${wr1.toFixed(0)}%`}
                      </span>
                      <div className="text-[9px] text-slate-500">
                        {p.levels["1-only"].win}/{g1}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-center tabular-nums text-slate-300">{total}</td>
                    <td className="px-3 py-1.5 text-right">
                      <ChevronRight className="h-3.5 w-3.5 text-slate-500 inline" />
                    </td>
                  </tr>
                )
              })}
              {result.perPair.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                    No per-pair data yet — run a backtest.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sample 2-agree signals */}
      {result.sampleTwoAgree.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
            <Target className="h-3.5 w-3.5 text-amber-400" /> Recent 2-App-Agree Outcomes
          </div>
          <div className="rounded-md border border-slate-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-900/70 border-b border-slate-800">
                  <th className="text-left font-medium text-slate-400 px-3 py-1.5">Time (UTC)</th>
                  <th className="text-left font-medium text-slate-400 px-3 py-1.5">Pair</th>
                  <th className="text-center font-medium text-slate-400 px-3 py-1.5">Direction</th>
                  <th className="text-center font-medium text-slate-400 px-3 py-1.5">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {result.sampleTwoAgree.slice(0, 8).map((c, i) => (
                  <tr key={i} className="border-b border-slate-800/40 last:border-0">
                    <td className="px-3 py-1.5 text-slate-300 tabular-nums">
                      {fmtSigTime(c.ts)}
                    </td>
                    <td className="px-3 py-1.5 text-slate-200 font-medium">{c.pair}</td>
                    <td className="px-3 py-1.5 text-center">
                      <DirectionPill dir={c.direction as Direction} size="sm" />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <span className={cn(
                        "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold",
                        c.outcome === 1 ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
                      )}>
                        {c.outcome === 1 ? "WIN" : "LOSS"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="text-[11px] text-slate-500 flex items-center justify-between flex-wrap gap-2 pt-1">
        <span>
          Analyzed <strong className="text-slate-300">{result.totalSignals}</strong> signals →
          {" "}<strong className="text-slate-300">{result.totalClusters}</strong> consensus clusters ·
          {" "}<strong className="text-slate-300">{result.perPair.length}</strong> pairs
        </span>
        <span className="tabular-nums">
          Backtest ran at: {new Date(result.timestamp).toISOString().slice(11, 19)} UTC
        </span>
      </div>
    </div>
  )
}
