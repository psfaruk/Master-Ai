"use client"

import { useEffect, useState } from "react"
import type { Candle } from "@/lib/candle-fetcher"

interface UseCandlesResult {
  candles: Candle[]
  loading: boolean
  error: string | null
}

/**
 * useCandles
 * ----------
 * Client hook that fetches candle history for one pair from /api/candles.
 * Polls every 5s so the chart stays fresh while the user is on the page.
 *
 * We pass `pair` as the cache key — when the user switches pairs, we
 * re-fetch immediately rather than waiting for the next interval.
 */
export function useCandles(pair: string | null, pollMs: number = 5000): UseCandlesResult {
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pair) {
      setCandles([])
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const fetchOnce = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/candles?pair=${encodeURIComponent(pair)}&limit=60`, {
          cache: "no-store",
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        setCandles(json.candles ?? [])
        setError(null)
      } catch (e: any) {
        if (cancelled) return
        setError(e?.message ?? "Failed to fetch candles")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchOnce()
    const loop = () => {
      void fetchOnce().finally(() => {
        if (!cancelled) timer = setTimeout(loop, pollMs)
      })
    }
    timer = setTimeout(loop, pollMs)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [pair, pollMs])

  return { candles, loading, error }
}
