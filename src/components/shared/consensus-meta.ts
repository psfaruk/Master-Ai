import type { ConsensusLevel } from "@/lib/signal-aggregator"

/**
 * Visual metadata for each consensus level. Centralised here so every
 * component that renders a consensus badge (the table, the highlights,
 * the candle history) uses the same colours and labels.
 */
export const CONSENSUS_META: Record<
  ConsensusLevel,
  { label: string; color: string; bg: string; border: string; ring: string }
> = {
  "3-agree": {
    label: "3 BOT AGREE",
    color: "text-emerald-300",
    bg: "bg-emerald-500/15",
    border: "border-emerald-500/40",
    ring: "ring-emerald-500/30",
  },
  "2-agree": {
    label: "2 BOT AGREE",
    color: "text-amber-300",
    bg: "bg-amber-500/15",
    border: "border-amber-500/40",
    ring: "ring-amber-500/30",
  },
  conflict: {
    label: "CONFLICT",
    color: "text-rose-300",
    bg: "bg-rose-500/15",
    border: "border-rose-500/40",
    ring: "ring-rose-500/30",
  },
  "1-only": {
    label: "SINGLE BOT",
    color: "text-slate-300",
    bg: "bg-slate-500/15",
    border: "border-slate-500/40",
    ring: "ring-slate-500/30",
  },
  none: {
    label: "NO SIGNAL",
    color: "text-slate-400",
    bg: "bg-slate-700/30",
    border: "border-slate-700/40",
    ring: "ring-slate-700/30",
  },
}
