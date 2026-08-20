"""Candle Fetcher.

Fetches historical OHLC candle data from App 3 (OTC Live Trading) and builds
a per-pair candle map that the backtest + history UI can use to:

1. Determine win/loss for ANY signal — even ones whose source app doesn't
   expose an outcome field (notably App 2). We look up the candle by
   (pair, ctime) and compare the candle's direction (close - open) to the
   signal's direction (CALL/PUT).
2. Render a small candle chart for each pair — open/close (and high/low for
   the current candle, via share-signals' ``prediction_candle``).

Data sources:

- ``/api/signals?limit=N`` — historical rows: ``{asset, ctime, signal, result,
  a_open, a_close, ...}``
- ``/api/share-signals`` — current live candle per pair: ``{asset, time,
  signal, prediction_candle: {open, high, low, close}}``

The cache is in-memory. Refresh interval is short (currently REFETCH_SEC = 45s)
because we want fresh prices for the chart, but we DON'T prune historical
candles — those are stable forever (a closed candle never changes).
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .http_fetcher import fetch_json_with_timeout
from .signal_normalize import (
    DIRECTION_KEYS,
    PAIR_KEYS,
    canonical_pair,
    candle_floor,
    parse_direction,
    pick_array,
    pick_field,
    to_unix_seconds,
)

logger = logging.getLogger("master-ai.candle_fetcher")

APP3_HIST_URL = "https://otclivedata.up.railway.app/api/signals?limit=500"
APP3_LIVE_URL = "https://otclivedata.up.railway.app/api/share-signals"

REFETCH_SEC = 45.0
FAIL_BACKOFF_SEC = 5.0


@dataclass
class Candle:
    pair: str
    candle_time: int
    open: float
    high: Optional[float]
    low: Optional[float]
    close: float
    # App 3's own verdict: "correct"/"wrong"/"draw"/None
    result: Optional[str]
    # App 3's signal direction for this candle (used only to detect "no signal").
    app3_direction: Optional[str]
    fetched_at: float  # unix ms
    # True for candles from the RESOLVED historical endpoint (final open/close
    # of a closed candle). False for candles captured from the live feed,
    # whose ``close`` is the price at capture time (mid-candle) and must not
    # grade signals until the candle's minute has fully ended.
    is_final: bool = True


def grade_signal_against_candle(direction: str, candle: Optional[Candle]) -> str:
    """Compute win/loss/draw for a signal given the candle it was predicting.

    - CALL wins when close > open (price went up)
    - PUT wins when close < open (price went down)
    - DRAW when close == open (no movement — neither won nor lost)

    Returns ``"UNKNOWN"`` when the candle data is missing (the candle hasn't
    closed yet, or App 3 doesn't track this pair). A live-captured candle
    (``is_final=False``) is only gradable once its minute has fully ended —
    grading a still-forming candle against a mid-minute close produces a
    verdict that can flip seconds later and silently corrupted the win rate.
    """
    if candle is None:
        return "UNKNOWN"
    if not candle.is_final and candle.candle_time >= candle_floor(int(time.time())):
        # The candle is still forming — its close keeps moving. Do NOT grade.
        return "UNKNOWN"
    if candle.close is None or not math.isfinite(candle.close):
        return "UNKNOWN"
    if candle.open is None or not math.isfinite(candle.open):
        return "UNKNOWN"

    diff = candle.close - candle.open
    # Use a tiny epsilon so floating-point noise doesn't turn a flat candle
    # into a tiny win.
    eps = 1e-9
    if abs(diff) < eps:
        return "DRAW"
    if direction == "CALL":
        return "WIN" if diff > 0 else "LOSS"
    return "WIN" if diff < 0 else "LOSS"


@dataclass
class CandleCacheState:
    # pair -> candleTime -> Candle
    candles: Dict[str, Dict[int, Candle]] = field(default_factory=dict)
    last_fetch_at: float = 0.0
    last_fetch_ok: bool = False
    fetch_in_progress: bool = False
    total_candles: int = 0
    task: Optional[asyncio.Task] = None
    # Initial kick-off refresh — tracked so lifespan shutdown can cancel
    # it (previously fire-and-forget, leaked on shutdown). (REVIEW-1 H7.)
    initial_task: Optional[asyncio.Task] = None


_state: Optional[CandleCacheState] = None


def _get_state() -> CandleCacheState:
    global _state
    if _state is None:
        _state = CandleCacheState()
    return _state


def _upsert_candle(st: CandleCacheState, c: Candle) -> None:
    pair_map = st.candles.setdefault(c.pair, {})
    pair_map[c.candle_time] = c


async def _fetch_historical_candles() -> List[Candle]:
    data = await fetch_json_with_timeout(APP3_HIST_URL, 10.0)
    if not data:
        return []
    rows = pick_array(data, ["signals", "rows", "data"])
    out: List[Candle] = []
    now_ms = time.time() * 1000

    for row in rows:
        if not isinstance(row, dict):
            continue
        pair = canonical_pair(pick_field(row, PAIR_KEYS))
        if not pair:
            continue

        ctime = to_unix_seconds(pick_field(row, ["ctime", "candle_time", "time", "ts"]))
        if not (ctime > 0):
            continue

        candle_time = candle_floor(ctime)
        a_open = _float_or_nan(pick_field(row, ["a_open", "open", "open_price"]))
        a_close = _float_or_nan(pick_field(row, ["a_close", "close", "close_price"]))
        a_high = _float_or_nan(pick_field(row, ["a_high", "high"]))
        a_low = _float_or_nan(pick_field(row, ["a_low", "low"]))

        # Skip rows with no usable price data — they can't grade anything.
        if math.isnan(a_open) or math.isnan(a_close):
            continue

        result_raw = str(pick_field(row, ["result", "outcome"]) or "").lower()
        if result_raw in ("correct", "win"):
            result: Optional[str] = "correct"
        elif result_raw in ("wrong", "loss"):
            result = "wrong"
        elif result_raw == "draw":
            result = "draw"
        else:
            result = None

        out.append(Candle(
            pair=pair,
            candle_time=candle_time,
            open=a_open,
            close=a_close,
            high=a_high if not math.isnan(a_high) else None,
            low=a_low if not math.isnan(a_low) else None,
            result=result,
            app3_direction=parse_direction(pick_field(row, DIRECTION_KEYS)),
            fetched_at=now_ms,
        ))

    return out


async def _fetch_live_candles() -> List[Candle]:
    data = await fetch_json_with_timeout(APP3_LIVE_URL, 8.0)
    if not data:
        return []
    rows = pick_array(data, ["signals", "rows", "data"])
    out: List[Candle] = []
    now_sec = int(time.time())
    now_ms = now_sec * 1000

    for row in rows:
        if not isinstance(row, dict):
            continue
        pair = canonical_pair(pick_field(row, PAIR_KEYS))
        if not pair:
            continue
        dir_ = parse_direction(pick_field(row, DIRECTION_KEYS))
        t = to_unix_seconds(pick_field(row, ["time", "candle_time", "ctime", "ts"]))
        candle_time = candle_floor(t) if t > 0 else candle_floor(now_sec)

        pc = row.get("prediction_candle") if isinstance(row.get("prediction_candle"), dict) else None
        o = _float_or_nan(pc.get("open") if pc else None)
        h = _float_or_nan(pc.get("high") if pc else None)
        l = _float_or_nan(pc.get("low") if pc else None)
        c = _float_or_nan(pc.get("close") if pc else None)

        if math.isnan(o) or math.isnan(c):
            continue

        out.append(Candle(
            pair=pair,
            candle_time=candle_time,
            open=o,
            close=c,
            high=h if not math.isnan(h) else None,
            low=l if not math.isnan(l) else None,
            result=None,  # live candle, not yet resolved
            app3_direction=dir_,
            fetched_at=now_ms,
            # Live capture — ``close`` is the price at capture time, NOT the
            # final close. grade_signal_against_candle refuses to grade a
            # forming candle and only allows it once the minute has ended.
            is_final=False,
        ))

    return out


def _float_or_nan(v) -> float:
    if v is None:
        return float("nan")
    if isinstance(v, bool):
        return float("nan")
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return float("nan")


async def refresh_candles() -> None:
    """Refresh the cache from both endpoints. Idempotent — concurrent calls
    coalesce into a single fetch."""
    st = _get_state()
    if st.fetch_in_progress:
        return
    st.fetch_in_progress = True
    try:
        # Historical first — these are authoritative for closed candles.
        try:
            hist = await _fetch_historical_candles()
        except Exception as e:
            logger.warning("[candle-cache] historical fetch error: %s", e)
            hist = []
        try:
            live = await _fetch_live_candles()
        except Exception as e:
            logger.warning("[candle-cache] live fetch error: %s", e)
            live = []

        for c in hist:
            _upsert_candle(st, c)

        # Live — only insert if we don't already have a candle for this
        # (pair, candleTime) from the historical set, OR if the existing
        # entry is missing high/low (the live set has full OHLC).
        for c in live:
            pair_map = st.candles.get(c.pair)
            existing = pair_map.get(c.candle_time) if pair_map else None
            if existing is None:
                _upsert_candle(st, c)
            elif (existing.high is None or existing.low is None) and (c.high is not None and c.low is not None):
                # Keep the historical open/close/result — those are
                # authoritative once the candle has a historical row — and
                # only backfill the high/low the live endpoint uniquely has.
                existing.high = c.high
                existing.low = c.low

        st.total_candles = sum(len(pm) for pm in st.candles.values())
        st.last_fetch_at = time.time() * 1000
        st.last_fetch_ok = True
    except Exception as e:
        st.last_fetch_ok = False
        logger.error("[candle-cache] refresh error: %s", e)
    finally:
        st.fetch_in_progress = False


async def _poll_loop() -> None:
    """Background loop — runs forever until cancelled on shutdown.

    ``asyncio.CancelledError`` is allowed to propagate so the lifespan
    shutdown hook can cleanly stop the loop.
    """
    while True:
        try:
            await refresh_candles()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # pragma: no cover — defensive
            logger.error("[candle-cache] loop iteration error: %s", e)
        await asyncio.sleep(REFETCH_SEC)


def start_candle_poller() -> None:
    """Start the background poller. Idempotent — safe to call from every
    route handler that needs candle data."""
    st = _get_state()
    if st.task is not None and not st.task.done():
        return
    # Track the kick-off refresh so lifespan shutdown can cancel it cleanly
    # (previously fire-and-forget — REVIEW-1 H7).
    st.initial_task = asyncio.create_task(refresh_candles())
    st.task = asyncio.create_task(_poll_loop())
    logger.info("[candle-cache] started — refreshing every %.1fs", REFETCH_SEC)


def get_candle(pair: str, candle_time_sec: int) -> Optional[Candle]:
    st = _get_state()
    pm = st.candles.get(canonical_pair(pair))
    if not pm:
        return None
    return pm.get(candle_floor(candle_time_sec))


def grade_signal(pair: str, candle_time_sec: int, direction: str) -> Tuple[Optional[Candle], str]:
    """Look up a candle AND compute the win/loss outcome for a signal.

    This is the canonical way to grade a signal: even if the source app
    doesn't report an outcome, we grade against the actual candle close.
    """
    candle = get_candle(pair, candle_time_sec)
    return candle, grade_signal_against_candle(direction, candle)


def get_candles_for_pair(pair: str, min_count: Optional[int] = None) -> List[Candle]:
    st = _get_state()
    pm = st.candles.get(canonical_pair(pair))
    out: List[Candle] = list(pm.values()) if pm else []
    out.sort(key=lambda c: c.candle_time, reverse=True)
    if min_count and len(out) < min_count:
        # Trigger a refresh in the background — caller gets stale data now,
        # fresh data on next poll. We do NOT track this task on the state
        # object because it's a one-shot per-call refresh (not a long-lived
        # loop) — but log it so /api/diag can see the trigger fired.
        # (REVIEW-1 H7, third site.)
        logger.debug("[candle-cache] below min_count=%d for %s, refreshing", min_count, pair)
        asyncio.create_task(refresh_candles())
    return out


def get_total_candles() -> int:
    return _get_state().total_candles


def reset_candle_cache_for_tests() -> None:
    st = _get_state()
    st.candles.clear()
    st.total_candles = 0
    st.last_fetch_at = 0.0
    st.last_fetch_ok = False


def get_candle_cache_stats() -> dict:
    st = _get_state()
    return {
        "running": st.task is not None and not st.task.done(),
        "lastFetchAt": st.last_fetch_at,
        "lastFetchAgeMs": int(time.time() * 1000 - st.last_fetch_at) if st.last_fetch_at > 0 else -1,
        "lastFetchOk": st.last_fetch_ok,
        "totalCandles": st.total_candles,
        "pairs": len(st.candles),
    }
