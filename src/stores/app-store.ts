"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { DEFAULT_TAB, type TabId } from "@/lib/tabs"

/**
 * Global UI state for the dashboard.
 *
 * Why Zustand + persist:
 *   - The active tab and the user's display settings should survive a page
 *     refresh. localStorage persistence is the simplest reliable way.
 *   - The store is intentionally UI-only — it does NOT hold signal data.
 *     Signal data is fetched by <AppShell> via the useSignals hook and
 *     passed down as props, so switching tabs does NOT trigger refetches.
 */
export interface AppSettings {
  /** Whether the 5s polling loop is running. */
  autoRefresh: boolean
  /** Polling interval in milliseconds. 5000 / 10000 / 30000 / 60000. */
  pollIntervalMs: number
  /** Whether to attempt a WebSocket push connection in addition to polling. */
  websocketEnabled: boolean
  /** Show signals whose source is stale (older than the freshness window). */
  showStaleSignals: boolean
  /** Show the "late" badge for apps that emitted outside the candle window. */
  showLateBadges: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  autoRefresh: true,
  pollIntervalMs: 5_000,
  websocketEnabled: true,
  showStaleSignals: false,
  showLateBadges: true,
}

interface AppState {
  activeTab: TabId
  setActiveTab: (tab: TabId) => void

  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      activeTab: DEFAULT_TAB,
      setActiveTab: (tab) => set({ activeTab: tab }),

      settings: DEFAULT_SETTINGS,
      updateSettings: (patch) =>
        set((state) => ({ settings: { ...state.settings, ...patch } })),
    }),
    {
      name: "master-ai-ui",
      // Only persist user settings + active tab, not transient state.
      partialize: (state) => ({
        activeTab: state.activeTab,
        settings: state.settings,
      }),
    }
  )
)
