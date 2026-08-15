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
│   ├── candle_fetcher.py    # App 3 OHLC candle cache + gradeSignal()
│   ├── signal_aggregator.py # 3-app aggregator + consensus classifier
│   ├── backtest_runner.py   # consensus backtest + per-pair win rate
│   ├── snapshot_poller.py   # adaptive background poller
│   ├── api/
│   │   ├── __init__.py
│   │   └── routes.py        # /api/{aggregated,candles,backtest,snapshot,diag}
│   ├── templates/
│   │   └── dashboard.html
│   └── static/
│       ├── dashboard.css
│       └── dashboard.js
└── tests/
    ├── conftest.py
    ├── test_signal_normalize.py
    ├── test_candle_fetcher.py
    └── test_signal_aggregator.py
```

## Run locally

```bash
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Then open <http://localhost:8000> for the dashboard, or hit the JSON
endpoints directly:

- `GET /api/aggregated` — unified snapshot + per-pair consensus
- `GET /api/candles?pair=USDCOP_otc&limit=60` — per-pair candle history
- `GET /api/backtest` — consensus accuracy backtest
- `GET /api/snapshot` — cached aggregated snapshot (cheap read)
- `GET /api/diag` — alignment diagnostics

## Tests

```bash
python -m pytest tests/ -v
```

The suite mirrors the original TypeScript tests:

- `test_signal_normalize.py` — canonical pair keys, timestamp normalization,
  wall-clock string parsing across timezones, look-ahead rejection.
- `test_candle_fetcher.py` — WIN/LOSS/DRAW grading logic.
- `test_signal_aggregator.py` — integration tests with the 3 upstreams
  faked, verifying cross-app alignment, NEUTRAL handling, App 2 fallback to
  cached candles when live fails, etc.

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

The included `railway.json` + `nixpacks.toml` configure the build:

1. Install Python 3.12.
2. `pip install -r requirements.txt`.
3. Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`.

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
