# Master-Ai — Python edition

A FastAPI port of the original Next.js/TypeScript Quotex signal aggregator
dashboard. Fetches CALL/PUT signals from three upstream signal apps hosted
on Railway, normalizes them, computes per-pair / per-candle consensus,
grades win/loss outcomes against actual candle closes, and runs a backtest
across the last 6 hours of history.

## Stack

- **Python 3.12** + **FastAPI** + **uvicorn**
- **httpx** for async HTTP (replaces Node's `fetch()`)
- **asyncio** background tasks for the App 2 cache, candle cache, and
  adaptive snapshot poller
- **Jinja2** for the server-rendered dashboard shell
- **pytest** for tests

## Project layout

```
Master-Ai/
├── main.py                  # FastAPI app entrypoint
├── requirements.txt
├── railway.json             # Railway deployment config
├── nixpacks.toml            # Nixpacks build config
├── Procfile                 # Heroku-style start command
├── app/
│   ├── __init__.py
│   ├── signal_normalize.py  # canonical pair keys, timestamp parsing, candle alignment
│   ├── http_fetcher.py      # httpx wrapper with timeout + retry
│   ├── app2_cache.py        # App 2 historical signal cache + poller
│   ├── candle_fetcher.py     # App 3 OHLC candle cache + gradeSignal()
│   ├── signal_aggregator.py # 3-app aggregator + consensus classifier
│   ├── backtest_runner.py   # consensus backtest + per-pair win rate (cached 60s)
│   ├── snapshot_poller.py   # adaptive background poller
│   ├── api/
│   │   ├── __init__.py
│   │   └── routes.py        # /api/{snapshot, aggregated, signal-feed, pairs,
│   │                       #         pair/{pair}, candles, backtest, backtest/status, diag}
│   ├── templates/
│   │   └── dashboard.html   # bottom-nav + dropdowns + drawer
│   └── static/
│       ├── dashboard.css    # mobile-first, dark/light themes
│       └── dashboard.js     # adaptive polling, settings persistence
└── tests/
    ├── conftest.py
    ├── test_signal_normalize.py
    ├── test_candle_fetcher.py
    ├── test_signal_aggregator.py
    └── test_new_dashboard.py  # endpoints + per-pair win rate + timing
```

## Dashboard sitemap

The dashboard is a single-page app with **bottom navigation** (mobile-first,
thumb-reachable):

```
┌──────────────────────────────────────────────────────────────┐
│ TOP BAR: Brand | UTC clock + Local clock | Category ▾ Search Status │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ HOME — 4 hero stats (3-agree/2-agree/conflict/single)        │
│        3 app status cards (latency, uptime, streams)         │
│        Top Signals panel + Live Signal Feed panel             │
│        Consensus Accuracy backtest summary                   │
│                                                              │
│ SIGNALS — filter bar (Level ▾ Direction ▾ ★ Favorites        │
│           Only-3-agree ☐) + per-pair table with              │
│           Signal Time UTC, Candle UTC, Lead, Win Rate, Graded │
│           Row-tap → drawer with candle chart + per-app       │
│           signal breakdown + per-pair win rate                │
│                                                              │
│ HISTORY — sub-tabs: Backtest | Per-Pair Stats | Pair         │
│           Drilldown. Cached backtest + manual rerun.          │
│                                                              │
│ SETTINGS — General (theme, language, timezone, time format)  │
│            Real-time Refresh (polling mode, feed size,        │
│            sound, notifications)                              │
│            Trading Filters (min win rate, fresh-only,        │
│            hide conflicts, favorites)                         │
│            App Candle Offsets (App 1/2/3 -3..+3)             │
│            Diagnostics (engineer-facing, hidden from main nav)│
│            Data & About (clear cache, reset, version, GitHub)│
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ BOTTOM NAV: 🏠 Home  📡 Signals  📊 History  ⚙ Settings       │
└──────────────────────────────────────────────────────────────┘
```

### Dropdowns

- **Top bar**: Category (All / OTC / Real) — global filter
- **Signals tab**: Level (All / 3-agree / 2-agree / Conflict / Single),
  Direction (Both / CALL / PUT)
- **History tab**: sub-tab switch, pair drilldown picker
- **Settings tab**: Theme, Language, Clock display, Time format,
  Polling mode, Feed size, App 1/2/3 candle offsets

### Real-time updates

The client mirrors the server's adaptive polling cadence:
- **Burst** (1s) during the first 12s of each candle (new signals arriving)
- **Idle** (3s) for the rest of the minute

Override this in Settings → Real-time Refresh → Polling mode.

### Per-pair win rate

Every pair in the snapshot now carries `winRate`, `gradedTotal`, and
per-level stats from the cached backtest (60s TTL). The backtest runs in
the background — the snapshot endpoint returns the cached value without
blocking.

### Signal source timing

Each signal shows:
- `emittedUtc` (HH:MM:SS UTC) — when the source app emitted it
- `candleUtc` (HH:MM UTC) — which candle it is FOR
- `leadSec` (candle - emit; positive = prediction, negative = during candle)
- color-coded status: prediction (green) / live (blue) / stale (gray) /
  look-ahead (red, suspicious)

## Run locally

```bash
pip install -r requirements.txt -r requirements-dev.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Then open <http://localhost:8000> for the dashboard, or hit the JSON
endpoints directly:

- `GET /api/snapshot` — cached aggregated snapshot + per-pair win rate
  (the dashboard polls this)
- `GET /api/aggregated` — full unified snapshot (verbose)
- `GET /api/signal-feed?limit=N` — flat chronological list of freshest
  signals with emitted-at + candle-time + lead/lag timing
- `GET /api/pairs?category=&level=&direction=&q=` — filtered per-pair
  listing with win rate
- `GET /api/pair/{pair}?candle_limit=N` — single-pair drilldown:
  signals + candles + app2 history + win rate
- `GET /api/candles?pair=USDCOP_otc&limit=60` — per-pair candle history
- `GET /api/backtest` — run fresh backtest (writes to cache)
- `GET /api/backtest/status` — cache age + verdict summary (cheap)
- `GET /api/diag` — alignment diagnostics (engineer-facing)

## Tests

```bash
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest tests/ -v
```

The suite covers:

- `test_signal_normalize.py` — canonical pair keys, timestamp normalization,
  wall-clock string parsing across timezones, look-ahead rejection.
- `test_candle_fetcher.py` — WIN/LOSS/DRAW grading logic.
- `test_signal_aggregator.py` — integration tests with the 3 upstreams
  faked, verifying cross-app alignment, NEUTRAL handling, App 2 fallback.
- `test_new_dashboard.py` — new endpoints, per-pair win rate enrichment,
  signal timing fields, backtest cache, pair filters.

## Environment variables

All optional. The app uses in-memory caches only — no database.

```
# Per-app candle offsets, in whole candles, clamped to ±5.
# /api/diag will tell you the exact value to set, if any.
APP1_CANDLE_OFFSET=0
APP2_CANDLE_OFFSET=0
APP3_CANDLE_OFFSET=0

# Port the FastAPI app listens on (Railway injects this automatically).
PORT=8000
```

## Deploy to Railway

```bash
railway up
```

The build uses a **Dockerfile** (preferred — pins Python 3.12 exactly and
deterministically):

1. `python:3.12-slim` base image
2. `pip install -r requirements.txt` (cached layer)
3. `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Healthcheck on `/health` (Railway probes this to know when ready)

A `nixpacks.toml` fallback is also included for hosts that don't support
custom Dockerfiles — it pins Python 3.12 via `nixPkgs = ["python312"]` and
tells nixpacks this is a Python project (NOT Node, even if the repo ever
contained a `package.json`).

### Why Dockerfile over nixpacks?

A previous deployment accidentally ran the **Next.js** app instead of the
Python port because nixpacks autodetected Node from a stale `package.json`
and built the wrong image. The Dockerfile eliminates this ambiguity — the
base image and the start command are both explicit.

### Why no apt-get?

The Dockerfile makes zero `apt-get install` calls. Two build failures in a
row on Railway pushed us here:

1. `build-essential` → OOM (compiling httptools/uvloop killed the container)
2. Plain `apt-get update` → also OOM'd/timed out (the Debian `trixie`
   package index is ~10MB and downloading+parsing it on Railway's smallest
   plan exceeded the build budget — `runc run failed: container process is
   already dead`)

The slim `python:3.12-slim` base image has everything we already need:
Python 3.12, pip, the standard library. Anything else (TLS certs, HTTP
client, framework) comes from PyPI as pre-built wheels.

For TLS verification specifically we depend on **`certifi`** rather than
the OS `ca-certificates` package — `app/http_fetcher.py` builds an
`ssl.SSLContext` from `certifi.where()` and passes it to httpx explicitly.
This makes upstream HTTPS calls work even in minimal images that don't
ship `ca-certificates`.

### Local Docker

```bash
docker build -t master-ai .
docker run -p 8000:8000 -e PORT=8000 master-ai
```

## Development

```bash
# Install runtime + test deps
pip install -r requirements.txt -r requirements-dev.txt

# Run tests
python -m pytest tests/ -v

# Run the dev server with auto-reload
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## How it works

The three upstream Quotex signal apps all lack CORS headers, so the browser
cannot call them directly. This app fans out server-side using `httpx` +
`asyncio.gather` for parallel fetches.

Key alignment rules (see `signal_normalize.py`):

- Every pair name goes through `canonical_pair()` so App 1's `symbol`,
  App 2's `pair` and App 3's `asset` land on the SAME dict key.
- Every timestamp goes through `to_unix_seconds()` so a millisecond field
  can't push a candle 50,000 years into the future.
- Consensus is computed per `(pair, candle)`. A signal counts for a candle
  when it was emitted in time for that candle — NOT when it happens to be
  younger than N minutes relative to now.

The adaptive snapshot poller (`snapshot_poller.py`) refreshes the cache every
800ms during the first 12s of each candle (when new signals are arriving)
and every 3s for the remainder of the minute — the original TS app's
solution to the "signals appear 27-32s late" complaint.

The backtest runner (`backtest_runner.py`) caches its result for 60s so the
snapshot endpoint can read per-pair win rates without paying the ~3s
backtest cost on every poll.