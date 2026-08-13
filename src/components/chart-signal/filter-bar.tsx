"use client"

import { Filter } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ConsensusFilter = "all" | "3-agree" | "2-agree" | "conflict"
export type CategoryFilter  = "all" | "otc" | "real"

interface FilterBarProps {
  consensus: ConsensusFilter
  category: CategoryFilter
  onConsensusChange: (v: ConsensusFilter) => void
  onCategoryChange: (v: CategoryFilter) => void
  showingCount: number
  totalCount: number
}

const CONSENSUS_OPTIONS: ReadonlyArray<[ConsensusFilter, string]> = [
  ["all",       "All"],
  ["3-agree",   "3 Agree"],
  ["2-agree",   "2 Agree"],
  ["conflict",  "Conflict"],
] as const

const CATEGORY_OPTIONS: ReadonlyArray<[CategoryFilter, string]> = [
  ["all",  "All"],
  ["otc",  "OTC"],
  ["real", "Real"],
] as const

/** The consensus + type filter row above the pair table. */
export function FilterBar({
  consensus, category,
  onConsensusChange, onCategoryChange,
  showingCount, totalCount,
}: FilterBarProps) {
  return (
    <section className="flex items-center gap-2 flex-wrap">
      <Filter className="h-4 w-4 text-slate-400" />
      <span className="text-xs text-slate-400 mr-1">Consensus:</span>
      {CONSENSUS_OPTIONS.map(([key, label]) => (
        <Button
          key={key}
          size="sm"
          variant="ghost"
          onClick={() => onConsensusChange(key)}
          aria-pressed={consensus === key}
          className={cn(
            "h-7 px-2.5 text-xs",
            consensus === key
              ? "bg-slate-700 text-white hover:bg-slate-700"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          )}
        >
          {label}
        </Button>
      ))}
      <div className="h-4 w-px bg-slate-700 mx-1" />
      <span className="text-xs text-slate-400 mr-1">Type:</span>
      {CATEGORY_OPTIONS.map(([key, label]) => (
        <Button
          key={key}
          size="sm"
          variant="ghost"
          onClick={() => onCategoryChange(key)}
          aria-pressed={category === key}
          className={cn(
            "h-7 px-2.5 text-xs",
            category === key
              ? "bg-slate-700 text-white hover:bg-slate-700"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          )}
        >
          {label}
        </Button>
      ))}
      <div className="ml-auto text-xs text-slate-500">
        Showing {showingCount} / {totalCount} pairs
      </div>
    </section>
  )
}
