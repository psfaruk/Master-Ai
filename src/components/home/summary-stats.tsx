"use client"

import { Layers, CheckCircle2, Activity, AlertTriangle, TrendingUp } from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface SummaryStatsProps {
  totalPairs: number
  threeBotAgreeCount: number
  twoBotAgreeCount: number
  conflictCount: number
  callCount: number
  putCount: number
}

const TONES: Record<string, string> = {
  slate:   "border-slate-800 bg-slate-900/40 text-slate-300",
  emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  amber:   "border-amber-500/30 bg-amber-500/10 text-amber-300",
  rose:    "border-rose-500/30 bg-rose-500/10 text-rose-300",
  teal:    "border-teal-500/30 bg-teal-500/10 text-teal-300",
}

function StatCard({
  label, value, icon, tone, pulse = false,
}: {
  label: string
  value: number | string
  icon: React.ReactNode
  tone: "slate" | "emerald" | "amber" | "rose" | "teal"
  pulse?: boolean
}) {
  return (
    <Card className={cn("p-3 border", TONES[tone])}>
      <div className="flex items-center gap-2 mb-1">
        <span className={cn("opacity-70", pulse && "animate-pulse")}>{icon}</span>
        <span className="text-[11px] uppercase tracking-wide opacity-70">{label}</span>
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </Card>
  )
}

/** The 5-card stat row shown on the Home tab. */
export function SummaryStats({
  totalPairs, threeBotAgreeCount, twoBotAgreeCount,
  conflictCount, callCount, putCount,
}: SummaryStatsProps) {
  return (
    <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <StatCard label="Total Pairs"     value={totalPairs}           icon={<Layers className="h-4 w-4" />}        tone="slate" />
      <StatCard label="3 Bot Agree"     value={threeBotAgreeCount}   icon={<CheckCircle2 className="h-4 w-4" />} tone="emerald" pulse={threeBotAgreeCount > 0} />
      <StatCard label="2 Bot Agree"     value={twoBotAgreeCount}     icon={<Activity className="h-4 w-4" />}     tone="amber" />
      <StatCard label="Conflicts"       value={conflictCount}        icon={<AlertTriangle className="h-4 w-4" />} tone="rose" />
      <StatCard label="CALL / PUT"      value={`${callCount} / ${putCount}`} icon={<TrendingUp className="h-4 w-4" />} tone="teal" />
    </section>
  )
}
