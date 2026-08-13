/**
 * Small formatting helpers shared across tabs.
 *
 * All time formatting here is timezone-aware on the CLIENT side only —
 * callers must ensure these are invoked from event handlers or effects,
 * not during SSR, to avoid hydration mismatches.
 */

/** "5s ago" / "3m ago" / "2h ago" — for signal age. */
export function fmtAgo(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

/** HH:MM:SS in the user's local timezone. Pass 0 to render a placeholder. */
export function fmtClock(ms: number): string {
  if (!ms) return "--:--:--"
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false })
}

/** HH:MM:SS in UTC — for table cells where we want a stable, locale-independent value. */
export function fmtSigTime(tsSec: number): string {
  if (!tsSec) return "--:--:--"
  return new Date(tsSec * 1000).toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" })
}
