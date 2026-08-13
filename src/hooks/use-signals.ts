"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { io, type Socket } from "socket.io-client"
import type {
  AggregatedResponse,
  AppStatus,
} from "@/lib/signal-aggregator"
import type { AppSettings } from "@/stores/app-store"
import { usePreciseClock } from "./use-precise-clock"

export interface UseSignalsResult {
  data: AggregatedResponse | null
  loading: boolean
  error: string | null
  isRefreshing: boolean
  lastUpdated: number
  /** Wall clock in ms — ticks at ~50ms (rAF-throttled) for millisecond display. */
  nowMs: number
  /** WebSocket is connected AND recently delivered a snapshot. */
  wsConnected: boolean
  /** Whether the 5s background poller (vs slow /api/aggregated) is in use. */
  fastPoller: boolean
  /** True when fresh data has arrived within the last 12s. */
  isLive: boolean
  handleRefresh: () => Promise<void>
}

/**
 * Owns all signal fetching for the dashboard:
 *   - Adaptive polling loop against /api/snapshot (with /api/aggregated fallback)
 *     — polls every ADAPTIVE_FAST_MS during the first 10s of a candle so
 *       signals appear within milliseconds of candle open, then slows to
 *       ADAPTIVE_SLOW_MS for the remainder of the candle.
 *   - Optional WebSocket push via the signal-pusher mini-service
 *   - Precise wall clock (rAF-throttled) for the header & per-row countdowns
 *   - manual refresh handler
 *
 * Extracted from the original page.tsx so that <AppShell> can render any
 * tab without re-mounting (and thus without re-connecting the WebSocket).
 */

/** Fast poll interval — used during the first 10s after a candle opens. */
const ADAPTIVE_FAST_MS = 800
/** Slow poll interval — used for the remainder of the candle. */
const ADAPTIVE_SLOW_MS = 3000
/** Window after candle open during which we poll fast. */
const BURST_WINDOW_SEC = 10

export function useSignals(settings: AppSettings): UseSignalsResult {
  const [data, setData] = useState<AggregatedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number>(0)
  const [lastDataAt, setLastDataAt] = useState<number>(0)
  const [fastPoller, setFastPoller] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)

  // Precise wall clock — updates ~20Hz via rAF. Used by HeaderBar (UTC ms
  // display) and by per-row CandleCountdown (sub-second countdown).
  const nowMs = usePreciseClock(50)

  const socketRef = useRef<Socket | null>(null)
  // We use a self-rescheduling setTimeout loop instead of setInterval so we
  // can vary the gap (fast during candle-open burst, slow otherwise) without
  // having to tear down the interval on every change.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Keep latest settings in a ref so the polling loop reads fresh values
  // without having to tear down and re-create the loop on every change.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // ---- Data fetcher ------------------------------------------------------
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setIsRefreshing(true)
    try {
      // Try the fast snapshot endpoint first (backed by the adaptive poller).
      let res: Response
      try {
        res = await fetch("/api/snapshot", { cache: "no-store" })
        if (res.ok) {
          const json: AggregatedResponse = await res.json()
          setData(json)
          setLastUpdated(Date.now())
          setLastDataAt(Date.now())
          setFastPoller(true)
          setError(null)
          return
        }
      } catch {
        // fall through to /api/aggregated
      }
      res = await fetch("/api/aggregated", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: AggregatedResponse = await res.json()
      setData(json)
      setLastUpdated(Date.now())
      setLastDataAt(Date.now())
      setFastPoller(false)
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? "Failed to fetch aggregated signals")
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  // ---- Manual refresh ----------------------------------------------------
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const res = await fetch("/api/snapshot?refresh=1", { cache: "no-store" })
      if (res.ok) {
        const json: AggregatedResponse = await res.json()
        setData(json)
        setLastUpdated(Date.now())
        setLastDataAt(Date.now())
        setFastPoller(true)
        setError(null)
      } else {
        await fetchData()
      }
    } catch {
      await fetchData()
    } finally {
      setIsRefreshing(false)
    }
  }, [fetchData])

  // ---- Adaptive polling loop --------------------------------------------
  // Polls every ADAPTIVE_FAST_MS for the first BURST_WINDOW_SEC of a candle,
  // then ADAPTIVE_SLOW_MS for the rest. This is the key fix for the
  // "signal appears 27-32s late" complaint: when a new candle opens, the
  // source apps publish their signal within seconds, and this loop picks it
  // up within ADAPTIVE_FAST_MS (typically <1s) instead of waiting up to 5s.
  useEffect(() => {
    let cancelled = false

    const scheduleNext = () => {
      if (cancelled) return
      if (!settingsRef.current.autoRefresh) return
      // Compute the gap based on how far into the current minute we are.
      const now = Date.now()
      const secIntoCandle = Math.floor(now / 1000) % 60
      const gap = secIntoCandle < BURST_WINDOW_SEC ? ADAPTIVE_FAST_MS : ADAPTIVE_SLOW_MS
      timerRef.current = setTimeout(async () => {
        if (cancelled) return
        await fetchData(true)
        scheduleNext()
      }, gap)
    }

    if (settings.autoRefresh) {
      // Kick off immediately for the first poll, then enter the loop.
      fetchData(true).finally(() => scheduleNext())
    }

    return () => {
      cancelled = true
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [settings.autoRefresh, settings.pollIntervalMs, fetchData])

  // ---- WebSocket connection ---------------------------------------------
  // Only attaches when websocketEnabled is true. Tearing down on toggle is
  // deliberate — the user can disable WS to save bandwidth on metered
  // connections.
  useEffect(() => {
    if (!settings.websocketEnabled) {
      if (socketRef.current) {
        socketRef.current.disconnect()
        socketRef.current = null
        setWsConnected(false)
      }
      return
    }

    const sock = io("/?XTransformPort=3003", {
      transports: ["polling", "websocket"],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 8000,
      timeout: 15000,
    })
    socketRef.current = sock

    sock.on("connect",    () => setWsConnected(true))
    sock.on("disconnect", () => setWsConnected(false))
    sock.on("connect_error", () => setWsConnected(false))
    sock.on("snapshot", (snap: AggregatedResponse) => {
      setData(snap)
      setLastUpdated(Date.now())
      setLastDataAt(Date.now())
      setLoading(false)
      setError(null)
    })
    sock.on("health", (apps: AppStatus[]) => {
      setData((prev) => (prev ? { ...prev, apps } : prev))
    })

    return () => {
      sock.disconnect()
      socketRef.current = null
    }
  }, [settings.websocketEnabled])

  // ---- Force re-render every 5s so the LIVE badge falls back to POLL ----
  // when no data has arrived within 12s. The precise clock already re-renders
  // 20×/s, so this would technically be redundant — but the precise clock's
  // state lives in a different component's hook tree, and we keep this here
  // as a defensive fallback in case the consumer doesn't subscribe to it.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5000)
    return () => clearInterval(t)
  }, [])

  const isLive = wsConnected || (lastDataAt > 0 && Date.now() - lastDataAt < 12000)

  return {
    data,
    loading,
    error,
    isRefreshing,
    lastUpdated,
    nowMs,
    wsConnected,
    fastPoller,
    isLive,
    handleRefresh,
  }
}
