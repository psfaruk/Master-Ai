import { AppShell } from "@/components/layout/app-shell"

/**
 * Root page. The entire dashboard lives inside <AppShell>, which owns
 * signal data fetching, backtest state, and the responsive tab navigation
 * (bottom-nav on mobile, sidebar on desktop).
 *
 * See ROADMAP.md for the full architecture.
 */
export default function Home() {
  return <AppShell />
}
