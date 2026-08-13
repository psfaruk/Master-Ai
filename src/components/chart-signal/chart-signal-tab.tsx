"use client"

import { useMemo, useState } from "react"
import type { AggregatedResponse } from "@/lib/signal-aggregator"
import type { AppSettings } from "@/stores/app-store"
import { FilterBar, type ConsensusFilter, type CategoryFilter } from "./filter-bar"
import { PairTable } from "./pair-table"

interface ChartSignalTabProps {
  data: AggregatedResponse
  settings: AppSettings
}

/**
 * Chart Signal tab: filter bar + pair table.
 *
 * Filter state is local to this tab (not in the Zustand store) because it's
 * transient UI state that should reset when the user navigates away.
 */
export function ChartSignalTab({ data, settings }: ChartSignalTabProps) {
  const [filter, setFilter] = useState<ConsensusFilter>("all")
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all")

  const filteredPairs = useMemo(() => {
    return data.pairs.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false
      if (filter === "all") return true
      return p.consensus.level === filter
    })
  }, [data, filter, categoryFilter])

  return (
    <>
      <FilterBar
        consensus={filter}
        category={categoryFilter}
        onConsensusChange={setFilter}
        onCategoryChange={setCategoryFilter}
        showingCount={filteredPairs.length}
        totalCount={data.pairs.length}
      />
      <PairTable pairs={filteredPairs} showLateBadges={settings.showLateBadges} />
    </>
  )
}
