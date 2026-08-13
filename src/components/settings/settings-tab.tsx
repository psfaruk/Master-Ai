"use client"

import {
  Settings as SettingsIcon, RefreshCw, Wifi, Eye, AlertTriangle,
  Shield, Github,
} from "lucide-react"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AppSettings } from "@/stores/app-store"

interface SettingsTabProps {
  settings: AppSettings
  onUpdate: (patch: Partial<AppSettings>) => void
  onRefresh: () => void
  isRefreshing: boolean
}

const POLL_OPTIONS: ReadonlyArray<[number, string]> = [
  [5_000,  "5s"],
  [10_000, "10s"],
  [30_000, "30s"],
  [60_000, "1m"],
] as const

/**
 * Settings tab — user-tunable options + about + token-revoke reminder.
 */
export function SettingsTab({ settings, onUpdate, onRefresh, isRefreshing }: SettingsTabProps) {
  return (
    <div className="space-y-4">
      {/* Refresh & data */}
      <Card className="border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <RefreshCw className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-bold tracking-wide text-slate-100">Refresh &amp; Data</h2>
        </div>
        <div className="space-y-3">
          <ToggleRow
            label="Auto-refresh"
            description="Continuously poll /api/snapshot for fresh signals."
            checked={settings.autoRefresh}
            onChange={(v) => onUpdate({ autoRefresh: v })}
          />
          <div className="flex items-center justify-between gap-3 py-2 border-t border-slate-800">
            <div className="min-w-0">
              <div className="text-sm text-slate-100">Poll interval</div>
              <div className="text-[11px] text-slate-400">How often to fetch a new snapshot.</div>
            </div>
            <div className="flex items-center gap-1">
              {POLL_OPTIONS.map(([ms, label]) => (
                <Button
                  key={ms}
                  size="sm"
                  variant="ghost"
                  disabled={!settings.autoRefresh}
                  onClick={() => onUpdate({ pollIntervalMs: ms })}
                  className={cn(
                    "h-7 px-2.5 text-xs",
                    settings.pollIntervalMs === ms
                      ? "bg-slate-700 text-white hover:bg-slate-700"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <ToggleRow
            label="WebSocket push"
            description="Subscribe to the signal-pusher mini-service for instant updates."
            checked={settings.websocketEnabled}
            onChange={(v) => onUpdate({ websocketEnabled: v })}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="h-8 border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
            Force refresh now
          </Button>
        </div>
      </Card>

      {/* Display */}
      <Card className="border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Eye className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-bold tracking-wide text-slate-100">Display</h2>
        </div>
        <div className="space-y-1">
          <ToggleRow
            label="Show stale signals"
            description="Render signals whose source is older than the freshness window (dimmed)."
            checked={settings.showStaleSignals}
            onChange={(v) => onUpdate({ showStaleSignals: v })}
          />
          <ToggleRow
            label='Show "late" badges'
            description='Mark apps that emitted a signal outside the valid candle window.'
            checked={settings.showLateBadges}
            onChange={(v) => onUpdate({ showLateBadges: v })}
          />
          <div className="flex items-center justify-between gap-3 py-2 border-t border-slate-800">
            <div className="min-w-0">
              <div className="text-sm text-slate-100">Theme</div>
              <div className="text-[11px] text-slate-400">The dashboard is dark-only for now.</div>
            </div>
            <span className="text-xs text-slate-500 px-2 py-1 rounded-md border border-slate-700 bg-slate-900">Dark</span>
          </div>
        </div>
      </Card>

      {/* About */}
      <Card className="border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <SettingsIcon className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-bold tracking-wide text-slate-100">About</h2>
        </div>
        <div className="space-y-2 text-xs text-slate-400">
          <p>
            <strong className="text-slate-200">Master-Ai</strong> — QX Signal Aggregator Dashboard.
            Aggregates CALL/PUT signals from 3 Quotex analysis apps and shows
            per-pair consensus (2-bot agree / 3-bot agree / conflict) with
            candle-time alignment.
          </p>
          <p>
            Built on Next.js 16 · Tailwind CSS 4 · shadcn/ui.
            For educational use only — not financial advice. Trading binary
            options involves significant risk.
          </p>
          <a
            href="https://github.com/psfaruk/Master-Ai"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200"
          >
            <Github className="h-3 w-3" /> View source on GitHub
          </a>
        </div>
      </Card>

      {/* Token revoke reminder */}
      <Card className="border-amber-500/40 bg-amber-500/5 p-4">
        <div className="flex items-start gap-2.5">
          <Shield className="h-4 w-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold tracking-wide text-amber-200">
              Security: revoke your GitHub token
            </h2>
            <p className="text-xs text-amber-100/80 mt-1">
              If you shared a GitHub Personal Access Token (PAT) to deploy this
              app, revoke it now at{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-amber-200 hover:text-amber-100"
              >
                github.com/settings/tokens
              </a>
              . Tokens shared in chat are compromised the moment they are sent.
            </p>
          </div>
        </div>
      </Card>
    </div>
  )
}

function ToggleRow({
  label, description, checked, onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-t border-slate-800 first:border-t-0">
      <div className="min-w-0">
        <div className="text-sm text-slate-100">{label}</div>
        <div className="text-[11px] text-slate-400">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="scale-90" />
    </div>
  )
}
