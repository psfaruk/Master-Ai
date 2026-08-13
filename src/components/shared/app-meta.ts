import type { AppId } from "@/lib/signal-aggregator"

/**
 * Per-app display metadata. `accent` is a Tailwind colour name (used to pick
 * the coloured top-bar / icon background on the status card and table cells).
 */
export const APP_META: Record<AppId, { shortName: string; name: string; accent: string }> = {
  app1: { shortName: "App 1", name: "Minimum Pair",          accent: "amber" },
  app2: { shortName: "App 2", name: "Binary Signal Terminal", accent: "violet" },
  app3: { shortName: "App 3", name: "OTC Live Trading",       accent: "emerald" },
}
