"use client"

import { useState } from "react"
import { Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import type {
  AppId, ConsensusLevel, PairConsensus, SourceSignal,
} from "@/lib/signal-aggregator"
import type { CandleConsensus } from "@/lib/signal-aggregator"
import { APP_META } from "@/components/shared/app-meta"
import { CONSENSUS_META } from "@/components/shared/consensus-meta"
import { fmtAgo, fmtSigTime } from "@/components/shared/format"
import { DirectionPill } from "./direction-pill"
import { CandleCountdown } from "./candle-countdown"

interface PairRowProps {
  pair: PairConsensus
  /** Show "late" badges for apps that emitted outside the candle window. */
  showLateBadges: boolean
}

/**
 * One row in the pair table. Click to expand a per-app detail panel + the
 * candle-aligned history table.
 *
 * Defensive about missing fields: the snapshot may come from an older
 * cached version (mini-service hasn't been updated yet, browser received a
 * stale WS payload). Falls back to safe defaults so the table never crashes.
 */
export function PairRow({ pair, showLateBadges }: PairRowProps) {
  const [expanded, setExpanded] = useState(false)

  const c = pair.consensus ?? {
    level: "none" as ConsensusLevel,
    direction: null,
    agreeingApps: [],
    disagreeingApps: [],
    missingApps: [],
    invalidApps: [],
  }
  const meta = CONSENSUS_META[c.level] ?? CONSENSUS_META.none
  const lc = pair.latestCandle ?? null
  const candles = Array.isArray(pair.candles) ? pair.candles : []
  const signals = Array.isArray(pair.signals) ? pair.signals : []
  const invalidApps: AppId[] = Array.isArray(c.invalidApps) ? c.invalidApps : []

  const getSignal = (id: AppId): SourceSignal | undefined =>
    signals.find((s) => s.source === id)

  return (
    <>
      <tr
        className={cn(
          "border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors cursor-pointer",
          c.level === "3-agree" && "bg-emerald-500/[0.04]",
          c.level === "2-agree" && "bg-amber-500/[0.04]",
          c.level === "conflict" && "bg-rose-500/[0.04]"
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <div>
              <div className="font-medium text-slate-100">{pair.displayPair}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                {pair.category}
              </div>
            </div>
            {lc && (
              <div className="ml-auto text-right">
                <div className="text-[10px] text-slate-500 uppercase tracking-wide leading-none">Candle</div>
                <div
                  className="text-[12px] font-semibold tabular-nums text-cyan-300 leading-tight"
                  title={`Candle time (UTC, minute-floored)\nThis is the candle that the signals below are predicting.`}
                >
                  {fmtSigTime(lc.candleTime)}
                </div>
                <CandleCountdown
                  candleTimeSec={lc.candleTime}
                  className="block mt-0.5"
                />
              </div>
            )}
          </div>
        </td>
        {(["app1", "app2", "app3"] as AppId[]).map((id) => {
          const sig = getSignal(id)
          return (
            <td key={id} className="px-2 py-2.5 text-center align-middle">
              {sig ? (
                <div className="flex flex-col items-center gap-0.5">
                  <DirectionPill dir={sig.direction} size="sm" />
                  <span
                    className={cn(
                      "text-[10px] tabular-nums leading-tight",
                      sig.fresh ? "text-slate-400" : "text-slate-600"
                    )}
                    title={`Signal timestamp (UTC): ${fmtSigTime(sig.timestamp)}\nCandle: ${fmtSigTime(sig.candleTime)}\nAge: ${fmtAgo(sig.ageSec)}${sig.cached ? "\nSource: App 2 history cache" : ""}`}
                  >
                    {fmtSigTime(sig.timestamp)}
                    {sig.cached && <span className="text-violet-400/70" title="from App 2 history cache"> ·c</span>}
                  </span>
                </div>
              ) : showLateBadges && invalidApps.includes(id) ? (
                <span
                  className="inline-flex items-center justify-center h-6 px-2 text-[11px] text-amber-500/80 rounded-md border border-amber-500/30 bg-amber-500/5"
                  title="This app sent a signal for this candle, but outside the window in which it could count (too early, or after the candle closed)."
                >
                  late
                </span>
              ) : (
                <span className="inline-flex items-center justify-center h-6 px-2 text-[11px] text-slate-600 rounded-md border border-slate-800 bg-slate-900/40">
                  —
                </span>
              )}
            </td>
          )
        })}
        <td className="px-2 py-2.5 text-center">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold border",
              meta.bg, meta.color, meta.border
            )}
          >
            {meta.label}
          </span>
        </td>
        <td className="px-4 py-2.5">
          {c.direction ? (
            <div className="flex items-center gap-2">
              <DirectionPill dir={c.direction} />
              <span className="text-[11px] text-slate-500">
                {c.agreeingApps.length}/{c.agreeingApps.length + c.disagreeingApps.length}
              </span>
            </div>
          ) : (
            <span className="text-xs text-slate-500">—</span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="bg-slate-900/40 border-b border-slate-800/60">
          <td colSpan={6} className="px-4 py-3">
            {/* Per-app detail for the latest candle */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
              {(["app1", "app2", "app3"] as AppId[]).map((id) => {
                const sig = getSignal(id)
                const m = APP_META[id]
                return (
                  <div
                    key={id}
                    className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-300">
                        {m.shortName}
                      </span>
                      {sig ? <DirectionPill dir={sig.direction} size="sm" /> : (
                        <span className="text-[10px] text-slate-600">NO SIGNAL</span>
                      )}
                    </div>
                    {sig ? (
                      <div className="space-y-1 text-[11px] text-slate-400">
                        <div className="flex justify-between">
                          <span>Candle</span>
                          <span className="text-cyan-300 tabular-nums">{fmtSigTime(sig.candleTime)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Signal at</span>
                          <span className="text-slate-300 tabular-nums">{fmtSigTime(sig.timestamp)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Age</span>
                          <span className="text-slate-300 tabular-nums">{fmtAgo(sig.ageSec)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Confidence</span>
                          <span className="text-slate-300 tabular-nums">
                            {sig.confidence !== null
                              ? `${(sig.confidence * 100).toFixed(1)}%`
                              : "—"}
                          </span>
                        </div>
                        {sig.strength && (
                          <div className="flex justify-between">
                            <span>Strength</span>
                            <span className="text-slate-300">{sig.strength}</span>
                          </div>
                        )}
                        {sig.outcome && (
                          <div className="flex justify-between">
                            <span>Outcome</span>
                            <span
                              className={cn(
                                "font-medium",
                                sig.outcome === "WIN" || sig.outcome === "CORRECT"
                                  ? "text-emerald-400"
                                  : sig.outcome === "LOSS" || sig.outcome === "WRONG"
                                  ? "text-rose-400"
                                  : "text-slate-300"
                              )}
                            >
                              {sig.outcome}
                            </span>
                          </div>
                        )}
                        {sig.strategy && (
                          <div className="flex justify-between gap-2">
                            <span>Strategy</span>
                            <span className="text-slate-300 text-right truncate max-w-[140px]" title={sig.strategy}>
                              {sig.strategy}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : showLateBadges && invalidApps.includes(id) ? (
                      <div className="text-[11px] text-amber-500/80">
                        Sent a signal for this candle, but outside the valid
                        window — it was emitted too early, or only after the
                        candle had closed, so it does not count toward
                        consensus.
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-600">
                        No signal from this app for this candle.
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Historical candles table — candle-aligned consensus over time */}
            {candles.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-slate-400 mb-1.5 flex items-center gap-1.5">
                  <Clock className="h-3 w-3" />
                  Candle-aligned history ({candles.length} candles, newest first)
                </div>
                <div className="rounded-md border border-slate-800 overflow-hidden max-h-64 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0">
                      <tr className="bg-slate-900/95 border-b border-slate-800">
                        <th className="text-left font-medium text-slate-400 px-2 py-1">Candle</th>
                        <th className="text-center font-medium text-slate-400 px-1 py-1">A1</th>
                        <th className="text-center font-medium text-slate-400 px-1 py-1">A2</th>
                        <th className="text-center font-medium text-slate-400 px-1 py-1">A3</th>
                        <th className="text-center font-medium text-slate-400 px-2 py-1">Consensus</th>
                        <th className="text-center font-medium text-slate-400 px-1 py-1">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candles.slice(0, 30).map((cnd: CandleConsensus) => {
                        const agreeing = cnd.signals.filter((s) =>
                          cnd.consensus.agreeingApps.includes(s.source)
                        )
                        const outcomes = agreeing
                          .map((s) => s.outcome)
                          .filter((o): o is NonNullable<typeof o> => o != null)
                        let outcomeLabel: string = "—"
                        let outcomeColor: string = "text-slate-500"
                        if (outcomes.length > 0) {
                          const hasWin  = outcomes.some((o) => o === "WIN" || o === "CORRECT")
                          const hasLoss = outcomes.some((o) => o === "LOSS" || o === "WRONG")
                          if (hasWin && !hasLoss) {
                            outcomeLabel = "WIN"; outcomeColor = "text-emerald-400"
                          } else if (hasLoss && !hasWin) {
                            outcomeLabel = "LOSS"; outcomeColor = "text-rose-400"
                          } else if (hasWin && hasLoss) {
                            outcomeLabel = "MIXED"; outcomeColor = "text-amber-400"
                          } else {
                            outcomeLabel = "DRAW"; outcomeColor = "text-slate-400"
                          }
                        }
                        return (
                          <tr key={cnd.candleTime} className="border-b border-slate-800/40 last:border-0">
                            <td className="px-2 py-1 text-cyan-300 tabular-nums">
                              {fmtSigTime(cnd.candleTime)}
                            </td>
                            {(["app1", "app2", "app3"] as AppId[]).map((id) => {
                              const s = cnd.signals.find((x) => x.source === id)
                              return (
                                <td key={id} className="px-1 py-1 text-center">
                                  {s ? (
                                    <span className={cn(
                                      "font-bold text-[10px]",
                                      s.direction === "CALL" ? "text-emerald-400" :
                                      s.direction === "PUT"  ? "text-rose-400" : "text-slate-500"
                                    )}>
                                      {s.direction === "CALL" ? "▲" : s.direction === "PUT" ? "▼" : "—"}
                                    </span>
                                  ) : (
                                    <span className="text-slate-700">·</span>
                                  )}
                                </td>
                              )
                            })}
                            <td className="px-2 py-1 text-center">
                              <span className={cn(
                                "text-[10px] font-bold",
                                cnd.consensus.level === "3-agree" ? "text-emerald-300" :
                                cnd.consensus.level === "2-agree" ? "text-amber-300" :
                                cnd.consensus.level === "conflict" ? "text-rose-300" :
                                "text-slate-500"
                              )}>
                                {cnd.consensus.level === "3-agree" ? "3A" :
                                 cnd.consensus.level === "2-agree" ? "2A" :
                                 cnd.consensus.level === "conflict" ? "✗" :
                                 cnd.consensus.level === "1-only" ? "1" : "—"}
                                {cnd.consensus.direction && cnd.consensus.direction !== "NEUTRAL" && (
                                  <span className="ml-0.5">
                                    {cnd.consensus.direction === "CALL" ? "▲" : "▼"}
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className={cn("px-1 py-1 text-center text-[10px] font-bold", outcomeColor)}>
                              {outcomeLabel}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
