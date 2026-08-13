"use client"

import { useCallback, useEffect, useState } from "react"
import type { BacktestResult } from "@/lib/backtest-runner"

export interface UseBacktestResult {
  result: BacktestResult | null
  loading: boolean
  error: string | null
  run: () => Promise<void>
}

/**
 * Backtest fetcher + auto-rerun loop.
 *
 * Auto-runs once 5s after mount (so the snapshot loads first), then every
 * 2 minutes so the win-rate panel stays current. The user can also trigger
 * a manual run via `run()`.
 */
export function useBacktest(): UseBacktestResult {
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/backtest", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: BacktestResult = await res.json()
      setResult(json)
    } catch (e: any) {
      setError(e?.message ?? "Backtest failed")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const initialTimer = setTimeout(() => { void run() }, 5000)
    const intervalTimer = setInterval(() => { void run() }, 120000)
    return () => {
      clearTimeout(initialTimer)
      clearInterval(intervalTimer)
    }
  }, [run])

  return { result, loading, error, run }
}
