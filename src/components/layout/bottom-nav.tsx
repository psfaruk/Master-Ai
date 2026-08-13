"use client"

import { cn } from "@/lib/utils"
import { TABS, type TabId } from "@/lib/tabs"

interface BottomNavProps {
  activeTab: TabId
  onSelect: (tab: TabId) => void
}

/**
 * Mobile bottom navigation (rendered at <768px). Renders all 5 tabs as a
 * fixed-bottom bar with icon + short label. The fifth tab "Settings" uses
 * the icon-only variant on very narrow screens (<360px) — labels collapse
 * via Tailwind's responsive utilities.
 */
export function BottomNav({ activeTab, onSelect }: BottomNavProps) {
  return (
    <nav
      aria-label="Main navigation"
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-slate-800 bg-slate-950/95 backdrop-blur supports-[backdrop-filter]:bg-slate-950/85"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="grid grid-cols-5">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const isActive = tab.id === activeTab
          return (
            <li key={tab.id} className="contents">
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex flex-col items-center justify-center gap-0.5 py-2 px-1 transition-colors",
                  isActive
                    ? "text-emerald-300"
                    : "text-slate-400 hover:text-slate-200"
                )}
              >
                <Icon className={cn("h-5 w-5", isActive && "drop-shadow-[0_0_6px_rgba(16,185,129,0.6)]")} />
                <span className="text-[10px] font-medium leading-none truncate max-w-full">
                  {tab.shortLabel}
                </span>
                {isActive && (
                  <span className="absolute top-0 h-0.5 w-10 bg-emerald-400 rounded-full" />
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
