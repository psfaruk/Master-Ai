import type { LucideIcon } from "lucide-react"
import { Home, LineChart, History, MoreHorizontal, Settings } from "lucide-react"

export type TabId = "home" | "chart-signal" | "history" | "other" | "settings"

export interface TabDef {
  id: TabId
  label: string
  /** Short label used in the mobile bottom-nav where horizontal space is tight. */
  shortLabel: string
  icon: LucideIcon
}

/**
 * Single source of truth for the five top-level tabs. Both <Sidebar> and
 * <BottomNav> read from this list, so the icons and labels can never drift
 * between mobile and desktop.
 */
export const TABS: readonly TabDef[] = [
  { id: "home",         label: "Home",         shortLabel: "Home",    icon: Home },
  { id: "chart-signal", label: "Chart Signal", shortLabel: "Signal",  icon: LineChart },
  { id: "history",      label: "History",      shortLabel: "History", icon: History },
  { id: "other",        label: "Other",        shortLabel: "Other",   icon: MoreHorizontal },
  { id: "settings",     label: "Settings",     shortLabel: "Settings",icon: Settings },
] as const

export const DEFAULT_TAB: TabId = "home"
