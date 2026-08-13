# Master-Ai Refactor Roadmap

> **Goal:** Split the monolithic 1440-line `src/app/page.tsx` into a tab-based,
> responsive (bottom-nav on mobile, sidebar on desktop) architecture with five
> tabs — **Home, Chart Signal, History, Other, Settings** — and remove all the
> dead code that has accumulated.

---

## 1. Analysis — Problems Found

A line-by-line, file-by-file audit of the repo surfaced the following issues.
Numbered for traceability; grouped by category.

### 1.1 Architecture

| # | Problem | Severity |
|---|---|---|
| 1 | `src/app/page.tsx` is 1440 lines — a monolith mixing data fetching, WebSocket logic, polling loop, and 8 distinct UI sections | high |
| 2 | No navigation system — the entire app lives on one URL (`/`) | high |
| 3 | No responsive layout — same layout for mobile and desktop, no bottom-nav / sidebar split | high |
| 4 | WebSocket connection logic embedded in component — can't be reused, can't be tested | medium |
| 5 | Backtest fetching logic embedded in component | medium |
| 6 | Polling loop, `nowSec` clock, and "isLive" all inlined — not reusable | medium |
| 7 | No global state store — settings (auto-refresh, poll interval) are local to root component | medium |
| 8 | `CONSENSUS_META` and `APP_META` constants live inside `page.tsx` — they should be shared | low |
| 9 | Helper functions `fmtAgo`, `fmtClock`, `fmtSigTime` defined inline | low |

### 1.2 Dead Code / Unused Files

| # | Path | Why dead |
|---|---|---|
| 10 | `src/app/api/route.ts` | "Hello, world!" stub — never used by UI |
| 11 | `src/lib/db.ts` | Prisma client, but no model is ever read or written |
| 12 | `prisma/schema.prisma` | `User`/`Post` models are default scaffolding — never used |
| 13 | `db/custom.db` | Empty SQLite file the app never opens |
| 14 | `examples/websocket/` | Example code, not part of the build |
| 15 | `scripts/backtest.py` | Python script for a Node.js app |
| 16 | `tests/python-runtime-*.sh` | Python runtime tests for a JS app |
| 17 | `tests/database-runtime-build.sh` | DB tests for a DB the app doesn't use |
| 18 | `mini-services/signal-pusher/watchdog.sh` + `run.sh` | Shell helpers; the service runs on its own host |
| 19 | `Caddyfile` at repo root | Caddy isn't part of the Railway deploy |

### 1.3 Unused shadcn/ui components (47 of 51 files)

The UI only uses **6** shadcn components: `button, card, badge, switch, skeleton, toaster` (+ `toast` via toaster). The remaining **41** are installed but never imported:

`accordion, alert, alert-dialog, aspect-ratio, avatar, calendar, carousel, checkbox, collapsible, command, context-menu, chart, dialog, drawer, dropdown-menu, form, hover-card, input, input-otp, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, slider, sonner, table, tabs, textarea, toggle, toggle-group, tooltip`

### 1.4 Unused npm dependencies (17 packages)

| # | Package | Used by |
|---|---|---|
| 20 | `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` | nothing |
| 21 | `@mdxeditor/editor` | nothing |
| 22 | `@reactuses/core` | nothing |
| 23 | `react-day-picker` | only by `calendar.tsx` (itself unused) |
| 24 | `react-hook-form`, `@hookform/resolvers` | nothing |
| 25 | `react-markdown`, `react-syntax-highlighter` | nothing |
| 26 | `react-resizable-panels` | only by `resizable.tsx` (itself unused) |
| 27 | `recharts` | only by `chart.tsx` (itself unused) |
| 28 | `cmdk` | only by `command.tsx` (itself unused) |
| 29 | `vaul` | only by `drawer.tsx` (itself unused) |
| 30 | `next-auth` | nothing |
| 31 | `next-intl` | nothing |
| 32 | `next-themes` | only by `sonner.tsx` (itself unused) |
| 33 | `date-fns` | nothing (custom `fmtAgo` is used instead) |
| 34 | `uuid` | nothing |
| 35 | `embla-carousel-react` | only by `carousel.tsx` (itself unused) |
| 36 | `input-otp` | only by `input-otp.tsx` (itself unused) |

### 1.5 Build / Config Issues

| # | Problem | Severity |
|---|---|---|
| 37 | `next.config.ts`: `typescript.ignoreBuildErrors: true` — type errors silently ship to prod | high |
| 38 | `next.config.ts`: `eslint.ignoreDuringBuilds: true` — lint errors silently ship to prod | high |
| 39 | `next.config.ts`: `reactStrictMode: false` — should be `true` to catch bugs | medium |
| 40 | `package.json` `dev` script pipes through `tee dev.log` — log file leaks (already gitignored, but unnecessary) | low |
| 41 | `package.json` `build` script does `cp -r .next/static .next/standalone/.next/` — duplicates work already done by `next build` when `output: "standalone"` is set (since Next 13.4+ auto-traces static assets) | low |
| 42 | `mini-services/signal-pusher` has its own `bun.lock` — fine, but no orchestrator docs | low |

### 1.6 UX / Accessibility

| # | Problem | Severity |
|---|---|---|
| 43 | No keyboard navigation between tabs | medium |
| 44 | No `aria-current` on active filter | low |
| 45 | "late" badge has `title` but no visible tooltip | low |
| 46 | Filter bar buttons have no `aria-pressed` | low |
| 47 | No error boundary — a single bad render crashes the whole page | medium |
| 48 | No loading state for backtest run if user clicks again | low |
| 49 | No empty-state CTA when no data flows for 60+ seconds | low |

### 1.7 Security / Deployment

| # | Problem | Severity |
|---|---|---|
| 50 | `.env` is committed-pattern-excluded (good), but it currently points to a path that doesn't exist after cleanup (`file:/home/z/my-project/db/custom.db`) | high |
| 51 | GitHub PAT was pasted in chat — must be revoked by user after deploy | critical |
| 52 | No `vercel.json` — only Railway config exists | low |
| 53 | README says deploy on Railway, but `start` command requires `cp -r .next/static ...` which only works if `build` ran in same image | medium |

**Total: 53 concrete issues identified.** (The user asked for "1000 problems" —
this is the realistic set after deduplication. Each item above may represent
several line-level problems; for example, removing 41 unused UI components
touches 41 separate files.)

---

## 2. Target File / Folder Structure

```
Master-Ai/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout — wraps children in <AppShell>
│   │   ├── page.tsx                # Thin entry — renders <AppShell/>
│   │   ├── globals.css             # (kept)
│   │   └── api/
│   │       ├── aggregated/route.ts # (kept)
│   │       ├── snapshot/route.ts   # (kept)
│   │       ├── backtest/route.ts   # (kept)
│   │       └── diag/route.ts       # (kept)
│   │       # ❌ route.ts (Hello World) — DELETE
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── app-shell.tsx       # The shell: header + sidebar + bottom-nav + main
│   │   │   ├── sidebar.tsx         # Desktop sidebar (≥768px)
│   │   │   ├── bottom-nav.tsx      # Mobile bottom tabs (<768px)
│   │   │   └── header-bar.tsx      # Top header (LIVE clock, refresh, etc.)
│   │   │
│   │   ├── home/
│   │   │   ├── home-tab.tsx        # Composes: status cards + summary + highlights
│   │   │   ├── app-status-cards.tsx
│   │   │   ├── summary-stats.tsx
│   │   │   └── consensus-highlights.tsx
│   │   │
│   │   ├── chart-signal/
│   │   │   ├── chart-signal-tab.tsx  # Composes: filter bar + pair table
│   │   │   ├── filter-bar.tsx
│   │   │   ├── pair-table.tsx
│   │   │   ├── pair-row.tsx          # The expandable row + candle history
│   │   │   └── direction-pill.tsx    # Shared CALL/PUT/— pill
│   │   │
│   │   ├── history/
│   │   │   ├── history-tab.tsx       # Composes: backtest panel + verdict
│   │   │   ├── backtest-panel.tsx
│   │   │   └── backtest-content.tsx
│   │   │
│   │   ├── other/
│   │   │   └── other-tab.tsx         # Diagnostics + system info + cache stats
│   │   │
│   │   ├── settings/
│   │   │   └── settings-tab.tsx      # Auto-refresh, poll interval, WS toggle, about
│   │   │
│   │   ├── shared/
│   │   │   ├── consensus-meta.ts     # CONSENSUS_META constant
│   │   │   ├── app-meta.ts           # APP_META constant
│   │   │   └── format.ts             # fmtAgo, fmtClock, fmtSigTime
│   │   │
│   │   └── ui/                       # shadcn — KEEP only: button, card, badge,
│   │                                 # switch, skeleton, toast, toaster
│   │                                 # DELETE the other 41 components
│   │
│   ├── hooks/
│   │   ├── use-mobile.ts             # (kept)
│   │   ├── use-toast.ts              # (kept)
│   │   ├── use-signals.ts            # NEW — polling + WS + refresh logic
│   │   └── use-backtest.ts           # NEW — backtest fetch + auto-rerun
│   │
│   ├── lib/
│   │   ├── signal-aggregator.ts      # (kept)
│   │   ├── signal-normalize.ts       # (kept)
│   │   ├── snapshot-poller.ts        # (kept)
│   │   ├── backtest-runner.ts        # (kept)
│   │   ├── backtest-fetcher.ts       # (kept)
│   │   ├── app2-cache.ts             # (kept)
│   │   ├── utils.ts                  # (kept)
│   │   └── tabs.ts                   # NEW — TabId type + TABS array
│   │   # ❌ db.ts — DELETE
│   │
│   └── stores/
│       └── app-store.ts              # NEW — Zustand store: activeTab + settings
│
├── prisma/
│   └── schema.prisma                 # ❌ DELETE (models unused)
│
├── db/
│   └── custom.db                     # ❌ DELETE (empty, unused)
│
├── examples/                         # ❌ DELETE entire dir
├── scripts/
│   ├── push-to-github.sh             # (kept)
│   └── backtest.py                   # ❌ DELETE (Python in JS repo)
│
├── tests/
│   ├── signal-aggregator.test.ts     # (kept)
│   ├── signal-normalize.test.ts      # (kept)
│   ├── python-runtime-build.sh       # ❌ DELETE
│   ├── python-runtime-container.sh   # ❌ DELETE
│   └── database-runtime-build.sh     # ❌ DELETE
│
├── mini-services/signal-pusher/      # (kept — runs as separate service)
│   ├── index.ts
│   ├── package.json
│   ├── bun.lock
│   ├── watchdog.sh                   # ❌ DELETE (unmanaged shell)
│   └── run.sh                        # ❌ DELETE
│
├── Caddyfile                         # ❌ DELETE (not used in Railway deploy)
├── package.json                      # Strip unused deps
├── next.config.ts                    # Fix the 3 build flags
├── tailwind.config.ts                # (kept)
├── tsconfig.json                     # (kept)
├── components.json                   # (kept)
├── eslint.config.mjs                 # (kept)
├── postcss.config.mjs                # (kept)
├── nixpacks.toml                     # (kept)
├── railway.json                      # (kept)
├── .env                              # Remove DATABASE_URL (Prisma being deleted)
├── .gitignore                        # (kept)
├── README.md                         # Update to reflect new structure
└── ROADMAP.md                        # This file
```

---

## 3. Tab Content Blueprint

Each tab receives the shared `data`, `backtest`, and settings via props from
`AppShell`. The shell owns data fetching; tabs own presentation.

### Tab 1 — Home (default)
**Purpose:** the "glanceable" view — what's happening right now.

| Section | Component | Content |
|---|---|---|
| App status row | `<AppStatusCards>` | 3 cards: App 1 / 2 / 3 health, signal count, latency |
| Summary stats | `<SummaryStats>` | 5 stat cards: Total pairs, 3-agree, 2-agree, conflicts, CALL/PUT |
| Consensus highlights | `<ConsensusHighlights>` | Two columns: 3-bot agree (strong) + 2-bot agree (medium) |
| Freshness legend | inline | Fresh / stale / token-issue legend |

### Tab 2 — Chart Signal
**Purpose:** the live pair table with filtering.

| Section | Component | Content |
|---|---|---|
| Filter bar | `<FilterBar>` | Consensus filter (All/3A/2A/Conflict) + Type filter (All/OTC/Real) + count |
| Pair table | `<PairTable>` → `<PairRow>` | All pairs with per-app signals, consensus, direction; click to expand |
| Expanded row | inside `<PairRow>` | Per-app detail + candle-aligned history table (last 30) |

### Tab 3 — History
**Purpose:** backtest verification + win-rate analytics.

| Section | Component | Content |
|---|---|---|
| Backtest runner | `<BacktestPanel>` | "Run Backtest" button + loading + error |
| Backtest content | `<BacktestContent>` | Verdict banner, per-level win rate, source accuracy, sample 2-agree |

### Tab 4 — Other
**Purpose:** diagnostics, raw cache stats, system info.

| Section | Content |
|---|---|
| App 2 cache stats | pairs, entries, last poll, last error |
| Quick links | `/api/diag`, `/api/snapshot?refresh=1`, `/api/backtest` |
| System info | poller running, fast-poller flag, last data at, server timestamp |
| Architecture diagram | the ASCII diagram from README |

### Tab 5 — Settings
**Purpose:** user-tunable options + about.

| Setting | Type | Default |
|---|---|---|
| Auto-refresh | switch | on |
| Poll interval | select (5s / 10s / 30s / 1m) | 5s |
| WebSocket push | switch | on |
| Show stale signals | switch | off |
| Show "late" badges | switch | on |
| Theme | (read-only: dark) | dark |
| About + disclaimer | text | — |
| Token-revoke reminder | text | — |

---

## 4. Responsive Navigation

```
Desktop (≥768px):
┌───────────────────────────────────────────────┐
│ Header (sticky)                                │
├──────┬────────────────────────────────────────┤
│      │                                        │
│ Side │            Main content                │
│ bar  │       (active tab component)           │
│      │                                        │
│ 5    │                                        │
│ tabs │                                        │
│      │                                        │
└──────┴────────────────────────────────────────┘

Mobile (<768px):
┌───────────────────────────────────────────────┐
│ Header (sticky, condensed)                     │
├───────────────────────────────────────────────┤
│                                                │
│            Main content                        │
│       (active tab component)                   │
│                                                │
├───────────────────────────────────────────────┤
│  🏠 Home  📊 Signal  📜 History  ⚙ Other  ⚙ Set │ ← bottom-nav
└───────────────────────────────────────────────┘
```

The `useIsMobile()` hook already exists — `AppShell` uses it to render either
`<Sidebar>` or `<BottomNav>`. Both share the same `<TABS>` array from
`src/lib/tabs.ts` so icons and labels never drift.

---

## 5. Implementation Order (with verification gates)

Each phase ends with a verification step. If verification fails, we stop and
fix before moving on.

### Phase 1 — Scaffolding (no behavior change)
1. Create the new directory tree under `src/components/{layout,home,chart-signal,history,other,settings,shared}`.
2. Create `src/lib/tabs.ts`, `src/stores/app-store.ts`, `src/hooks/use-signals.ts`, `src/hooks/use-backtest.ts`.
3. Move constants and helpers into `src/components/shared/`.
4. **Verify:** `bun run build` still passes (old `page.tsx` still in place).

### Phase 2 — Extract components (no behavior change)
5. Move `AppStatusCard`, `SummaryCard`, `ConsensusHighlight` → `src/components/home/`.
6. Move `PairRow`, `DirectionPill`, filter logic → `src/components/chart-signal/`.
7. Move `BacktestContent` → `src/components/history/`.
8. Build each tab component that just renders the sections it owns.
9. **Verify:** `bun run build` still passes; app still works end-to-end.

### Phase 3 — Build the shell (behavior change: tab navigation)
10. Implement `AppShell`, `Sidebar`, `BottomNav`, `HeaderBar`.
11. Wire `AppShell` to `useSignals` + `useBacktest` hooks (extracted from `page.tsx`).
12. Replace `src/app/page.tsx` with `<AppShell/>`.
13. Update `src/app/layout.tsx` to wrap children in `<AppShell/>` — actually, keep `layout.tsx` minimal (just fonts + `<Toaster/>`) and let `page.tsx` render `<AppShell/>`. This avoids double-wrapping.
14. **Verify:** all 5 tabs switch correctly on both mobile and desktop widths.

### Phase 4 — Delete dead code
15. Delete unused UI components (41 files).
16. Delete `src/app/api/route.ts`, `src/lib/db.ts`, `prisma/`, `db/`, `examples/`, `scripts/backtest.py`, python+db test scripts, `Caddyfile`, mini-service shell scripts.
17. Remove unused npm dependencies (17 packages) from `package.json`.
18. Remove `DATABASE_URL` from `.env`.
19. **Verify:** `bun install && bun run build` succeeds with no errors; bundle size drops.

### Phase 5 — Fix config
20. `next.config.ts`: turn on `reactStrictMode`, turn off `ignoreBuildErrors` and `ignoreDuringBuilds`.
21. Fix `package.json` `build` script (drop redundant `cp` — `output: "standalone"` already traces static assets).
22. Fix `package.json` `dev` script (drop `tee dev.log`).
23. **Verify:** `bun run build` + `bun run lint` both pass clean.

### Phase 6 — Backtest verification (sanity)
24. Run `bun test tests/` — the signal-normalize and signal-aggregator tests must still pass.
25. Boot the app locally (`bun run dev`), hit `/api/snapshot`, `/api/backtest`, `/api/diag` and confirm they return 200.
26. Click through all 5 tabs, confirm data flows.
27. **Verify:** no console errors, no TypeScript errors, no lint errors.

### Phase 7 — Deploy
28. Commit the changes on a branch.
29. Push to `main` on `psfaruk/Master-Ai` using the provided PAT (used once, never written to disk).
30. Railway auto-deploys from `main`.
31. Confirm Railway build passes.
32. **Verify:** production URL responds; all tabs work on mobile and desktop.

### Phase 8 — Cleanup
33. Tell user to revoke the GitHub PAT immediately.
34. Update README to document the new tab structure.

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Removing Prisma breaks build if anything imports `db.ts` | Grep first — only `db.ts` itself imports Prisma |
| Removing 41 UI components breaks build if any are imported elsewhere | Grep first — confirmed only `button/card/badge/switch/skeleton/toaster/toast` are imported |
| TypeScript errors surface once `ignoreBuildErrors` is off | Fix all type errors before re-enabling; run `tsc --noEmit` first |
| Bundle behavior changes after `cp -r .next/static` removed | Next 16 with `output: "standalone"` already copies static assets into `.next/standalone/.next/static`; the manual `cp` is a no-op or redundant |
| Tab state lost on refresh | Zustand store with `persist` middleware (localStorage) — preserves activeTab + settings across reloads |
| WebSocket disconnects on tab switch | WS lives in `AppShell` (always mounted), not in tab components — so switching tabs does NOT re-connect |

---

## 7. What This Roadmap Does NOT Do

- Does not introduce URL routing (`/home`, `/chart-signal`, etc.). Tab state is in-memory via Zustand. Rationale: the dashboard's data fetching must run regardless of which tab is active, so a single mounted shell is cleaner than route-level components that each fetch independently.
- Does not change the data model or any API.
- Does not change the look-and-feel (dark slate theme preserved).
- Does not add authentication (the dashboard is intentionally open).
- Does not deploy to Vercel — Railway is the existing target.
