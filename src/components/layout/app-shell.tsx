"use client"

import { Github, AlertTriangle } from "lucide-react"
import { Card } from "@/components/ui/card"
import { useAppStore } from "@/stores/app-store"
import { useSignals } from "@/hooks/use-signals"
import { useBacktest } from "@/hooks/use-backtest"
import { HeaderBar } from "./header-bar"
import { Sidebar } from "./sidebar"
import { BottomNav } from "./bottom-nav"
import { HomeTab } from "@/components/home/home-tab"
import { ChartSignalTab } from "@/components/chart-signal/chart-signal-tab"
import { HistoryTab } from "@/components/history/history-tab"
import { OtherTab } from "@/components/other/other-tab"
import { SettingsTab } from "@/components/settings/settings-tab"

/**
 * AppShell — the single mounted root of the dashboard.
 *
 * Responsibilities:
 *   - Owns all data fetching (useSignals + useBacktest) so switching tabs
 *     does NOT tear down the WebSocket or restart the polling loop.
 *   - Renders the responsive shell: <HeaderBar> on top, <Sidebar> on the
 *     left for desktop, <BottomNav> at the bottom for mobile.
 *   - Renders the active tab component, passing data as props.
 *
 * Tab state lives in the Zustand store (persisted to localStorage), so a
 * page refresh lands the user on the same tab they left.
 */
export function AppShell() {
  const activeTab   = useAppStore((s) => s.activeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const settings    = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const {
    data, loading, error, isRefreshing, lastUpdated,
    nowMs, wsConnected, fastPoller, isLive, handleRefresh,
  } = useSignals(settings)

  const {
    result: backtest, loading: backtestLoading, error: backtestError, run: runBacktest,
  } = useBacktest()

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <HeaderBar
        nowMs={nowMs}
        lastUpdated={lastUpdated}
        isLive={isLive}
        wsConnected={wsConnected}
        fastPoller={fastPoller}
        isRefreshing={isRefreshing}
        autoRefresh={settings.autoRefresh}
        onRefresh={handleRefresh}
        onToggleAutoRefresh={(v) => updateSettings({ autoRefresh: v })}
      />

      <div className="flex flex-1">
        <Sidebar activeTab={activeTab} onSelect={setActiveTab} />

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 space-y-5 pb-24 md:pb-5">
          {/* Error banner — always available regardless of active tab. */}
          {error && (
            <Card className="p-3 border-rose-500/40 bg-rose-500/10 text-rose-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span className="text-sm">Failed to refresh signals: {error}</span>
            </Card>
          )}

          {activeTab === "home" && (
            <HomeTab data={data} loading={loading} />
          )}

          {activeTab === "chart-signal" && data && (
            <ChartSignalTab data={data} settings={settings} />
          )}

          {activeTab === "chart-signal" && !data && loading && (
            <div className="text-sm text-slate-400 py-12 text-center">
              Loading signals…
            </div>
          )}

          {activeTab === "chart-signal" && !data && !loading && (
            <div className="text-sm text-slate-400 py-12 text-center">
              No data yet. Try a refresh.
            </div>
          )}

          {activeTab === "history" && (
            <HistoryTab
              backtest={backtest}
              backtestLoading={backtestLoading}
              backtestError={backtestError}
              onRunBacktest={runBacktest}
            />
          )}

          {activeTab === "other" && (
            <OtherTab
              data={data}
              isLive={isLive}
              fastPoller={fastPoller}
              wsConnected={wsConnected}
              lastUpdated={lastUpdated}
            />
          )}

          {activeTab === "settings" && (
            <SettingsTab
              settings={settings}
              onUpdate={updateSettings}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
            />
          )}
        </main>
      </div>

      <footer className="hidden md:block border-t border-slate-800 mt-auto">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between flex-wrap gap-2 text-xs text-slate-500">
          <span>
            Aggregates CALL/PUT signals from 3 Quotex analysis apps. For educational use — not financial advice.
          </span>
          <span className="flex items-center gap-1">
            <Github className="h-3 w-3" /> Built on Next.js 16
          </span>
        </div>
      </footer>

      <BottomNav activeTab={activeTab} onSelect={setActiveTab} />
    </div>
  )
}
