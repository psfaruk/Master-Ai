"use client"

import { cn } from "@/lib/utils"
import { TABS, type TabId } from "@/lib/tabs"

interface SidebarProps {
  activeTab: TabId
  onSelect: (tab: TabId) => void
}

/**
 * Desktop sidebar (rendered at ≥768px). Renders all 5 tabs vertically with
 * icon + label, and highlights the active one.
 */
export function Sidebar({ activeTab, onSelect }: SidebarProps) {
  return (
    <nav
      aria-label="Main navigation"
      className="hidden md:flex md:flex-col md:w-56 md:flex-shrink-0 md:border-r md:border-slate-800 md:bg-slate-950/60 md:sticky md:top-[57px] md:h-[calc(100vh-57px)] md:py-4"
    >
      <div className="px-3 mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Navigation
        </div>
      </div>
      <ul className="flex-1 space-y-1 px-2">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const isActive = tab.id === activeTab
          return (
            <li key={tab.id}>
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                  isActive
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                    : "text-slate-300 hover:bg-slate-800/60 border border-transparent"
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="px-3 py-2 border-t border-slate-800 mt-2">
        <div className="text-[10px] text-slate-500 leading-snug">
          v0.4.0 · tabbed UI
        </div>
      </div>
    </nav>
  )
}
