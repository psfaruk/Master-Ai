"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { io, type Socket } from "socket.io-client"
import type {
  AggregatedResponse,
  AppStatus,
} from "@/lib/signal-aggregator"
import type { AppSettings } from "@/stores/app-store"

export interface UseSignalsResult {
  data: AggregatedResponse | null
  loading: boolean
  error: string | null
  isRefreshing: boolean
  lastUpdated: number
  /** Wall clock in ms — ticks every 1s for the header. */
  nowSec: number
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
 *   - 5s polling loop against /api/snapshot (with /api/aggregated fallback)
 *   - Optional WebSocket push via the signal-pusher mini-service
 *   - 1s wall-clock tick for the header
 *   - manual refresh handler
 *
 * Extracted from the original page.tsx so that <AppShell> can render any
 * tab without re-mounting (and thus without re-connecting the WebSocket).
 */
export function useSignals(settings: AppSettings): UseSignalsResult {
  const [data, setData] = useState<AggregatedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number>(0)
  const [lastDataAt, setLastDataAt] = useState<number>(0)
  const [fastPoller, setFastPoller] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  const [nowSec, setNowSec] = useState<number>(0)

  const socketRef = useRef<Socket | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Keep latest settings in a ref so the polling loop reads fresh values
  // without having to tear down and re-create the interval on every change.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // ---- Data fetcher ------------------------------------------------------
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setIsRefreshing(true)
    try {
      // Try the fast snapshot endpoint first (backed by a 5s background poller).
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

  // ---- Polling loop ------------------------------------------------------
  // Re-created whenever autoRefresh or pollIntervalMs changes.
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (!settings.autoRefresh) return
    fetchData(true)
    timerRef.current = setInterval(() => fetchData(true), settings.pollIntervalMs)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [settings.autoRefresh, settings.pollIntervalMs, fetchData])

  // ---- WebSocket connection ---------------------------------------------
  // Only attaches when websocketEnabled is true. Tearing down on toggle is
  // deliberate — the user can disable WS to save bandwidth on metered
  // connections.
  useEffect(() => {
    if (!settings.websocketEnabled) {
      // Clean up any existing socket when the user toggles WS off.
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

  // ---- 1s wall clock -----------------------------------------------------
  useEffect(() => {
    setNowSec(Date.now())
    const t = setInterval(() => setNowSec(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // ---- Force re-render every 5s so the LIVE badge falls back to POLL ----
  // when no data has arrived within 12s. Without this, the badge would stay
  // stuck on LIVE until the next user interaction.
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
    nowSec,
    wsConnected,
    fastPoller,
    isLive,
    handleRefresh,
  }
}
