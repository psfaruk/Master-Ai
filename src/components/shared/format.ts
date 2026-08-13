/**
 * Small formatting helpers shared across tabs.
 *
 * ALL time formatting here is in UTC. The user requirement is that every
 * displayed time (wall clock, signal time, candle time, last-data) is
 * expressed in UTC — never local timezone. This avoids ambiguity when the
 * source apps sit in a different timezone from the viewer.
 *
 * These helpers are pure and SSR-safe — they only touch their argument, not
 * the system clock, so they can be called during render without causing
 * hydration mismatches.
 */

/** "5s ago" / "3m ago" / "2h ago" — for signal age. */
export function fmtAgo(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

/**
 * HH:MM:SS.mmm in UTC.
 *
 * The wall-clock display in the header. Updates externally via the
 * usePreciseClock hook (which uses requestAnimationFrame for ~16ms cadence),
 * so this function only formats whatever time it is handed.
 *
 * Pass 0 to render a placeholder while the client mounts.
 */
export function fmtClock(ms: number): string {
  if (!ms) return "--:--:--.---"
  return fmtUtc(ms, true)
}

/** HH:MM:SS in UTC (no milliseconds) — used by compact table cells. */
export function fmtClockSec(ms: number): string {
  if (!ms) return "--:--:--"
  return fmtUtc(ms, false)
}

/** HH:MM:SS in UTC — for table cells where we want a stable, locale-independent value. */
export function fmtSigTime(tsSec: number): string {
  if (!tsSec) return "--:--:--"
  return fmtUtcSec(tsSec, false)
}

/** HH:MM:SS.mmm in UTC for a unix-seconds timestamp (signal emission time). */
export function fmtSigTimeMs(tsSec: number): string {
  if (!tsSec) return "--:--:--.---"
  return fmtUtcSec(tsSec, true)
}

/**
 * "12s left" — seconds remaining in the current 1-minute candle.
 *
 * `candleTimeSec` is the candle's open time (unix seconds, minute-floored).
 * `nowMs` is the wall-clock in milliseconds. The result is the number of
 * seconds (with one decimal when sub-second precision is requested) before
 * the NEXT candle opens.
 *
 * Returns "—" when candleTime is zero (no signal yet for this pair).
 */
export function fmtCountdown(candleTimeSec: number, nowMs: number, withTenths = true): string {
  if (!candleTimeSec || !nowMs) return "—"
  const candleEndMs = (candleTimeSec + 60) * 1000
  const remainingMs = candleEndMs - nowMs
  if (remainingMs <= 0) {
    // Candle has already closed — caller should refresh to get the next one.
    return "0s"
  }
  const sec = remainingMs / 1000
  return withTenths ? `${sec.toFixed(1)}s` : `${Math.ceil(sec)}s`
}

// ---------------------------------------------------------------------------
// Internal — single source of truth for UTC formatting
// ---------------------------------------------------------------------------

function fmtUtc(msEpoch: number, withMs: boolean): string {
  const d = new Date(msEpoch)
  const hh = pad(d.getUTCHours())
  const mm = pad(d.getUTCMinutes())
  const ss = pad(d.getUTCSeconds())
  if (!withMs) return `${hh}:${mm}:${ss}`
  const mmm = pad3(d.getUTCMilliseconds())
  return `${hh}:${mm}:${ss}.${mmm}`
}

function fmtUtcSec(secEpoch: number, withMs: boolean): string {
  // Multiply by 1000 and reuse. Use Math.floor to avoid float drift on
  // sub-second fractions; we only display whole milliseconds.
  return fmtUtc(Math.floor(secEpoch * 1000), withMs)
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`
  if (n < 100) return `0${n}`
  return String(n)
}
