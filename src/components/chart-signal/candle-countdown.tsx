"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { fmtCountdown } from "@/components/shared/format"

/**
 * CandleCountdown
 * ---------------
 * Live "X.Xs left" display for a single pair's current candle.
 *
 * Why a dedicated component (instead of computing countdown inline in the
 * parent): the parent PairRow re-renders only when the snapshot payload
 * changes (~1-3s cadence), but the countdown needs to update at least every
 * 100ms for the sub-second display to feel "ticking". Putting the timer
 * inside the row would re-render the WHOLE row (and its expanded detail
 * panel) every 100ms, which is wasteful and causes the table to feel jittery.
 * Isolating the timer here means only this small <span> re-renders.
 *
 * Why not use the shared usePreciseClock hook from the parent and pass the
 * value down as a prop? That would also re-render the whole row 20× per
 * second — same problem. The countdown owns its own 100ms timer locally.
 *
 * The countdown is computed against UTC wall-clock time; the candle's open
 * time is also in UTC seconds (per the aggregator contract).
 *
 * Color cue:
 *   - > 20s remaining  → slate (calm)
 *   - 10-20s remaining → amber (signal about to "lock in")
 *   - < 10s remaining  → rose (candle about to close)
 */
export function CandleCountdown({
  candleTimeSec,
  className,
}: {
  candleTimeSec: number
  className?: string
}) {
  // Start at 0 to render "—" on the very first paint (avoids a flash of the
  // previous candle's countdown if this component is reused for a different
  // candle via key prop).
  const [nowMs, setNowMs] = useState<number>(0)

  useEffect(() => {
    // Reset on candle change so the countdown snaps immediately.
    setNowMs(Date.now())

    // 100ms interval gives 0.1s precision on the display, which is smooth
    // enough to feel "live" without burning CPU. We use setInterval (not
    // rAF) here because:
    //   - This is a leaf component with no expensive children, so 10 renders
    //     per second is cheap.
    //   - rAF pauses when the tab is hidden, but the countdown should still
    //     update when the user comes back. setInterval throttles to ~1Hz in
    //     background tabs, which is acceptable.
    const t = setInterval(() => setNowMs(Date.now()), 100)
    return () => clearInterval(t)
  }, [candleTimeSec])

  if (!candleTimeSec || !nowMs) {
    return <span className={cn("text-[10px] text-slate-600 tabular-nums", className)}>—</span>
  }

  const candleEndMs = (candleTimeSec + 60) * 1000
  const remainingMs = candleEndMs - nowMs
  const remainingSec = remainingMs / 1000

  const tone =
    remainingSec <= 0 ? "text-rose-400"
    : remainingSec < 10 ? "text-rose-300"
    : remainingSec < 20 ? "text-amber-300"
    : "text-slate-300"

  const label = remainingSec <= 0 ? "closed" : fmtCountdown(candleTimeSec, nowMs, true)

  return (
    <span
      className={cn(
        "text-[10px] tabular-nums leading-tight",
        tone,
        className
      )}
      title={`Candle closes at ${new Date(candleEndMs).toISOString().slice(11, 19)} UTC`}
    >
      {label}
    </span>
  )
}
