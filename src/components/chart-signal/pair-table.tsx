"use client"

import type { PairConsensus } from "@/lib/signal-aggregator"
import { PairRow } from "./pair-row"

interface PairTableProps {
  pairs: PairConsensus[]
  showLateBadges: boolean
}

/**
 * The full pair table. Renders inside a horizontally-scrollable container so
 * it works on narrow mobile screens.
 */
export function PairTable({ pairs, showLateBadges }: PairTableProps) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/80">
              <th className="text-left font-semibold text-slate-300 px-4 py-2.5">Pair</th>
              <th className="text-center font-semibold text-slate-300 px-2 py-2.5">
                <div className="flex flex-col items-center gap-0.5">
                  <span>App 1</span>
                  <span className="text-[10px] text-slate-500 font-normal">Min Pair</span>
                </div>
              </th>
              <th className="text-center font-semibold text-slate-300 px-2 py-2.5">
                <div className="flex flex-col items-center gap-0.5">
                  <span>App 2</span>
                  <span className="text-[10px] text-slate-500 font-normal">Binary Term</span>
                </div>
              </th>
              <th className="text-center font-semibold text-slate-300 px-2 py-2.5">
                <div className="flex flex-col items-center gap-0.5">
                  <span>App 3</span>
                  <span className="text-[10px] text-slate-500 font-normal">OTC Live</span>
                </div>
              </th>
              <th className="text-center font-semibold text-slate-300 px-2 py-2.5">Consensus</th>
              <th className="text-left font-semibold text-slate-300 px-4 py-2.5">Signal</th>
            </tr>
          </thead>
          <tbody>
            {pairs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500 text-sm">
                  No pairs match the current filter.
                </td>
              </tr>
            )}
            {pairs.map((p) => (
              <PairRow key={p.pair} pair={p} showLateBadges={showLateBadges} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
