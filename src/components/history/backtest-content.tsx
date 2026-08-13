"use client"

import {
  CheckCircle2, AlertTriangle, XCircle, Trophy, Target,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { AppId } from "@/lib/signal-aggregator"
import type {
  BacktestResult, ConsensusLevel as BtLevel,
} from "@/lib/backtest-runner"
import { DirectionPill } from "@/components/chart-signal/direction-pill"
import type { Direction } from "@/lib/signal-aggregator"

/** Renders the structured result of a backtest run. */
export function BacktestContent({ result }: { result: BacktestResult }) {
  const fmtPct = (n: number, d: number) => (d > 0 ? `${(n / d * 100).toFixed(1)}%` : "—")
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

      {/* Stats grid */}
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
          return (
            <div key={lvl} className={cn("rounded-lg border p-3", toneCls)}>
              <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
                {lvl === "3-agree" ? "3 BOT AGREE" :
                 lvl === "2-agree" ? "2 BOT AGREE" :
                 lvl === "conflict" ? "CONFLICT" : "SINGLE BOT"}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums text-slate-100">
                {graded > 0 ? `${wr.toFixed(1)}%` : "—"}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                {s.win}W / {s.loss}L / {s.unknown}?  · {s.total} total
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
                    {s.win}W / {s.loss}L / {s.unknown}?
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">{s.total} total signals</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Sample 2-agree signals */}
      {result.sampleTwoAgree.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
            <Target className="h-3.5 w-3.5 text-amber-400" /> Recent 2-Bot-Agree Outcomes
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
                      {new Date(c.ts * 1000).toISOString().slice(0, 19).replace("T", " ")}
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
          {" "}<strong className="text-slate-300">{result.totalClusters}</strong> consensus clusters
        </span>
        <span className="tabular-nums">
          Backtest ran at: {new Date(result.timestamp).toLocaleTimeString("en-GB", { hour12: false })}
        </span>
      </div>
    </div>
  )
}
