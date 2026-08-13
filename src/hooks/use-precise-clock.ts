"use client"

import { useEffect, useRef, useState } from "react"

/**
 * usePreciseClock
 * ---------------
 * A wall-clock hook that updates with sub-frame precision using
 * requestAnimationFrame.
 *
 * Why rAF instead of setInterval(1)?
 *   - setInterval(ms) with very small intervals is clamped to ~4ms by browsers
 *     and triggers expensive re-renders far more often than the screen can
 *     paint (~16.7ms at 60Hz). Using rAF ties the update cadence to the
 *     browser's paint cycle, so we re-render AT MOST once per frame — which is
 *     the fastest rate the user can actually perceive. A 1ms setInterval would
 *     cause 16× more renders per second for no visible benefit.
 *
 * Why not useSyncExternalStore?
 *   - We don't need tearing-free cross-component synchronization here; the
 *     clock is consumed by only a handful of components and the occasional
 *     1-frame skew between them is invisible. useState + rAF is simpler and
 *     equally smooth in practice.
 *
 * Returns the current wall clock in MILLISECONDS (UTC-agnostic — Date.now is
 * a pure instant; the timezone decision happens at format time).
 *
 * Optional `maxIntervalMs` clamps the gap between updates. If the tab is
 * backgrounded (rAF pauses), this hook falls back to a setInterval timer so
 * the displayed time does not freeze. Default: 50ms (20Hz), which is still
 * smooth enough for a "ticking" feel without burning CPU.
 */
export function usePreciseClock(maxIntervalMs: number = 50): number {
  const [now, setNow] = useState<number>(0)
  const rafRef = useRef<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSetRef = useRef<number>(0)

  useEffect(() => {
    // Initial paint — happens immediately so the clock is never "--:--:--"
    // for the first frame on the client.
    setNow(Date.now())
    lastSetRef.current = Date.now()

    const tick = () => {
      const t = Date.now()
      // Throttle: only setState when at least maxIntervalMs has elapsed OR
      // when the rAF callback fired (which is ~16ms). This prevents redundant
      // re-renders when rAF runs faster than the display cadence the consumer
      // actually needs.
      if (t - lastSetRef.current >= maxIntervalMs) {
        lastSetRef.current = t
        setNow(t)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    const startRaf = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick)
    }
    const stopRaf = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }

    // Pause rAF when the tab is hidden (the browser throttles it anyway),
    // and switch to setInterval so the clock keeps ticking (browsers throttle
    // background rAF to ~1Hz but the interval keeps running at its rate).
    const onVisibility = () => {
      if (document.hidden) {
        stopRaf()
        if (intervalRef.current == null) {
          intervalRef.current = setInterval(() => {
            const t = Date.now()
            if (t - lastSetRef.current >= maxIntervalMs) {
              lastSetRef.current = t
              setNow(t)
            }
          }, maxIntervalMs)
        }
      } else {
        if (intervalRef.current != null) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
        // Force a fresh paint immediately on resume so the displayed time
        // snaps to "now" instead of being one interval stale.
        lastSetRef.current = 0
        startRaf()
      }
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility)
    }
    startRaf()

    return () => {
      stopRaf()
      if (intervalRef.current != null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility)
      }
    }
  }, [maxIntervalMs])

  return now
}
