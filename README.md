# Master-Ai — QX Signal Aggregator Dashboard

A real-time dashboard that aggregates CALL/PUT trading signals from 3 Quotex analysis apps and shows per-pair consensus (2-bot agree / 3-bot agree / conflict) with candle-time alignment.

## Features

- **3-app consensus**: Pulls live signals from 3 source apps every 5s
- **Candle-time alignment**: Only compares signals for the SAME 1-minute candle across apps
- **Real-time updates**: Next.js background poller + optional Socket.IO push
- **App health monitoring**: Detects LIVE / TOKEN EXPIRED / DISCONNECTED / OFFLINE state
- **Backtest verification**: Auto-runs every 2 min, computes per-level win rate
- **Historical candle view**: Expand any pair to see per-candle consensus history with WIN/LOSS outcomes
- **Per-second clock**: Live ticking HH:MM:SS in header

## Source Apps

| App | Name | URL |
|---|---|---|
| App 1 | Minimum Pair | https://minimum-pair-production.up.railway.app |
| App 2 | Binary Signal Terminal | https://binary-signals-app-production.up.railway.app |
| App 3 | OTC Live Trading | https://otc-live-trading-production.up.railway.app |

## Tech Stack

- **Framework**: Next.js 16 (App Router, standalone output)
- **Language**: TypeScript 5
- **Styling**: Tailwind CSS 4 + shadcn/ui
- **Real-time**: Socket.IO (mini-service on port 3003, optional)
- **Database**: Prisma ORM (SQLite, optional)
- **Runtime**: Bun (dev) / Node.js 20 (production)

## Local Development

```bash
bun install
bun run db:push      # set up Prisma SQLite (only if using DB)
bun run dev          # start Next.js dev server on port 3000
```

Optional: start the signal-pusher mini-service for WebSocket push:

```bash
cd mini-services/signal-pusher
bun install
bun run dev          # starts Socket.IO server on port 3003
```

## Railway Deployment

This project is configured for one-click Railway deployment.

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/psfaruk/Master-Ai.git
git push -u origin main
```

### 2. Deploy on Railway

1. Go to https://railway.app/new
2. Select **Deploy from GitHub repo** → choose `psfaruk/Master-Ai`
3. Railway auto-detects Next.js via `nixpacks.toml` and `railway.json`
4. Set the following environment variables in Railway:
   - `PORT` = `3000` (Railway auto-sets this)
   - `NODE_ENV` = `production`
5. Click **Deploy** — Railway will:
   - Install deps with `bun install`
   - Build with `bun run build`
   - Start with `node .next/standalone/server.js`
6. Add a custom domain (optional) under Settings → Networking

### Auto-Deploy

Once connected, Railway auto-deploys on every `git push` to `main`. To disable, go to Settings → Deployments → turn off "Auto-deploy".

### Files That Configure Railway

- `railway.json` — Railway-specific deploy settings (start command, restart policy)
- `nixpacks.toml` — Build pipeline (Node.js 20 + Bun, install, build, start)
- `next.config.ts` — `output: "standalone"` for self-contained production server
- `package.json` — `build` and `start` scripts

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Railway (production)                    │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Next.js (port 3000)                             │    │
│  │  ├─ /api/aggregated  — fetch from 3 apps         │    │
│  │  ├─ /api/snapshot    — cached 5s background poller│    │
│  │  ├─ /api/backtest    — win-rate calculator        │    │
│  │  ├─ /api/diag        — alignment diagnostics      │    │
│  │  └─ src/lib/                                   │    │
│  │     ├─ signal-normalize.ts   — pair/time/candle  │    │
│  │     ├─ signal-aggregator.ts  — 3-app consensus   │    │
│  │     ├─ app2-cache.ts         — App 2 history     │    │
│  │     ├─ snapshot-poller.ts    — 5s cache refresh   │    │
│  │     └─ backtest-runner.ts    — candle-aligned BT  │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
        ▲                ▲                ▲
        │ fetch 5s       │ fetch 5s       │ fetch 5s
        ▼                ▼                ▼
   App 1 (Min Pair)  App 2 (Binary)  App 3 (OTC Live)
   Railway           Railway          Railway
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/snapshot` | Latest cached aggregated snapshot (5s refresh) |
| `GET /api/snapshot?refresh=1` | Force re-poll before returning |
| `GET /api/aggregated` | Direct aggregated fetch (no cache) |
| `GET /api/backtest` | Run candle-aligned backtest, return win rates |
| `GET /api/diag` | Alignment diagnostics — see below |
| `GET /api/diag?poll=1` | Same, after forcing one App 2 cache poll |

## Troubleshooting: an app's column is empty

Open `/api/diag`. It reports, per app: rows returned, rows dropped and why,
the pair keys it produced, and the newest candle it published. It also reports
`offsets` — the candle difference between each pair of apps, measured on pairs
they both cover.

- `apps[].rawRows = 0` → the upstream returned nothing. Check that app itself.
- `apps[].skipped.noPair / noDirection` high → the upstream renamed a field.
- `pairOverlap[].onlyIn` non-empty → the apps genuinely cover different assets
  (after canonicalization, spelling differences are no longer possible).
- `offsets[].modalOffsetCandles ≠ 0` → the two apps label candles differently:
  one tags the candle it analysed, the other the candle it predicts. Correct it
  with an environment variable rather than a code change:

  ```bash
  APP1_CANDLE_OFFSET=0    # candles to shift App 1's bucket by
  APP2_CANDLE_OFFSET=1    # e.g. App 2 is one candle behind the other two
  APP3_CANDLE_OFFSET=0
  ```

  `/api/diag` prints the exact variable to set in `offsets[].hint`.

## Consensus rules

Consensus is computed per **(pair, candle)** — never across candles:

- A signal counts for a candle if it was emitted at most 5 minutes before that
  candle and no later than 30s after it closed. Anything else is reported as
  `invalidApps` ("late" on the dashboard) rather than silently dropped.
- `3-agree` / `2-agree` require the participating apps to be **unanimous**.
  Two of three agreeing while the third disagrees is a `conflict`, not a
  2-agree.
- `NEUTRAL` rows do not vote; an app that is neutral counts as missing.

## Tests

```bash
bun test tests/
```

`tests/signal-normalize.test.ts` covers pair/timestamp/clock normalization;
`tests/signal-aggregator.test.ts` runs the aggregator against faked upstreams
that reproduce the real-world differences between the 3 apps (different pair
spellings, millisecond vs second timestamps, non-UTC clock strings).

## Disclaimer

For educational use only — not financial advice. Trading binary options involves significant risk.
