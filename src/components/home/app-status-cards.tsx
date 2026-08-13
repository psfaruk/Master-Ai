"use client"

import {
  Bot, Wifi, WifiOff, AlertTriangle,
} from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { AppId, AppStatus } from "@/lib/signal-aggregator"
import { APP_META } from "@/components/shared/app-meta"

/**
 * Status card for one of the 3 source apps. Shows health, signal count,
 * fresh-signal count, latency, uptime, and a link to the upstream URL.
 */
export function AppStatusCard({ app }: { app: AppStatus }) {
  const meta = APP_META[app.id as AppId]
  const isOnline = app.online
  const tokenIssue = app.health === "token_expired"
  const disconnected = app.health === "disconnected"
  const down = app.health === "down"

  let statusLabel: string
  let statusColor: string
  let statusBg: string
  let statusBorder: string
  let StatusIcon: typeof Wifi | typeof WifiOff | typeof AlertTriangle

  if (down) {
    statusLabel = "OFFLINE"
    statusColor = "text-rose-300"
    statusBg = "bg-rose-500/15"
    statusBorder = "border-rose-500/40"
    StatusIcon = WifiOff
  } else if (tokenIssue) {
    statusLabel = "TOKEN EXPIRED"
    statusColor = "text-amber-300"
    statusBg = "bg-amber-500/15"
    statusBorder = "border-amber-500/40"
    StatusIcon = AlertTriangle
  } else if (disconnected) {
    statusLabel = "DISCONNECTED"
    statusColor = "text-amber-300"
    statusBg = "bg-amber-500/15"
    statusBorder = "border-amber-500/40"
    StatusIcon = WifiOff
  } else if (app.live) {
    statusLabel = "LIVE"
    statusColor = "text-emerald-300"
    statusBg = "bg-emerald-500/15"
    statusBorder = "border-emerald-500/40"
    StatusIcon = Wifi
  } else {
    statusLabel = "ONLINE"
    statusColor = "text-emerald-300"
    statusBg = "bg-emerald-500/15"
    statusBorder = "border-emerald-500/40"
    StatusIcon = Wifi
  }

  const cardBorder =
    down || tokenIssue || disconnected ? "border-rose-500/30" : "border-slate-800"

  return (
    <Card
      className={cn(
        "p-4 border bg-slate-900/60 relative overflow-hidden",
        cardBorder
      )}
    >
      <div
        className={cn(
          "absolute top-0 left-0 right-0 h-0.5",
          down ? "bg-rose-500" :
          tokenIssue ? "bg-amber-500" :
          disconnected ? "bg-amber-500" :
          app.id === "app1" ? "bg-amber-500" :
          app.id === "app2" ? "bg-violet-500" : "bg-emerald-500"
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              "h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0",
              down ? "bg-rose-500/15 text-rose-400" :
              tokenIssue ? "bg-amber-500/15 text-amber-400" :
              disconnected ? "bg-amber-500/15 text-amber-400" :
              app.id === "app1" ? "bg-amber-500/15 text-amber-400" :
              app.id === "app2" ? "bg-violet-500/15 text-violet-400" :
              "bg-emerald-500/15 text-emerald-400"
            )}
          >
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-100 truncate">
              {meta.shortName}
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {meta.name}
            </div>
          </div>
        </div>
        <div
          className={cn(
            "flex items-center gap-1 px-1.5 py-0.5 rounded border flex-shrink-0",
            statusBg, statusBorder, statusColor
          )}
          title={app.detail ?? statusLabel}
        >
          <StatusIcon className="h-3 w-3" />
          <span className="text-[9px] font-bold tracking-wider">{statusLabel}</span>
        </div>
      </div>

      <div className="mt-2.5 text-[11px] leading-snug">
        {app.detail && (
          <div className={cn("flex items-start gap-1", statusColor)}>
            <span className="text-slate-500 font-medium flex-shrink-0">Status:</span>
            <span className="text-slate-300 break-all">{app.detail}</span>
          </div>
        )}
        {!app.detail && down && (
          <div className="text-rose-300 flex items-center gap-1">
            <span className="text-slate-500 font-medium">Status:</span>
            <span>Source app not responding — fetch failed</span>
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-slate-800/50 px-2 py-1.5">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Signals</div>
          <div className="text-slate-200 font-semibold tabular-nums">
            {app.signalCount}
          </div>
        </div>
        <div className="rounded-md bg-slate-800/50 px-2 py-1.5">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Fresh</div>
          <div className={cn(
            "font-semibold tabular-nums",
            app.freshSignalCount > 0 ? "text-emerald-300" : "text-slate-500"
          )}>
            {app.freshSignalCount}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px] text-slate-500">
        {typeof app.uptimeSec === "number" && (
          <span title="Upstream uptime">
            up {app.uptimeSec >= 3600 ? `${Math.floor(app.uptimeSec / 3600)}h` :
                app.uptimeSec >= 60 ? `${Math.floor(app.uptimeSec / 60)}m` :
                `${app.uptimeSec}s`}
          </span>
        )}
        {typeof app.activeStreams === "number" && (
          <span title="Active pair streams">{app.activeStreams} streams</span>
        )}
        {typeof app.latencyMs === "number" && (
          <span title="Last fetch latency">{app.latencyMs}ms</span>
        )}
      </div>

      {app.error && (
        <div className="mt-2 text-[10px] text-rose-300/80 truncate" title={app.error}>
          Error: {app.error}
        </div>
      )}
      <a
        href={app.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-[10px] text-slate-500 hover:text-slate-300 truncate max-w-full"
      >
        {app.url.replace("https://", "")}
      </a>
    </Card>
  )
}

/** Wrapper that renders all 3 app status cards in a responsive grid. */
export function AppStatusCards({ apps }: { apps: AppStatus[] }) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {apps.map((app) => (
        <AppStatusCard key={app.id} app={app} />
      ))}
    </section>
  )
}
