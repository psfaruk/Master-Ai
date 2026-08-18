"""App 2 Historical Signal Cache.

App 2's ``/api/share-signals`` only returns the CURRENT candle's snapshot.
Once a new candle starts, the previous signal is gone. To build a proper
candle-aligned consensus across the 3 apps, we need App 2's signal for each
historical candle — not just the current one.

This module polls App 2 every 5s (in the background) and stores, for each
``(pair, candleMinute)``, the signal App 2 produced. The aggregator then reads
from this cache to align with App 1 and App 3.

The cache is in-memory and keeps the last ``CACHE_TTL_SEC`` of history. It
lives on a module-level singleton — the asyncio task is started idempotently
so multiple route handlers can call ``start_app2_cache_poller()`` without
spinning up duplicate intervals.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .http_fetcher import fetch_json_with_timeout
from .signal_normalize import (
    DIRECTION_KEYS,
    PAIR_KEYS,
    canonical_pair,
    candle_floor,
    parse_direction,
    pick_array,
    pick_field,
    resolve_clock_to_candle,
    to_unix_seconds,
)

logger = logging.getLogger("master-ai.app2_cache")

APP2_URL = "https://binary-signals-app-production.up.railway.app/api/share-signals"
POLL_INTERVAL_SEC = 8.0
CACHE_TTL_SEC = 60 * 60  # keep 1 hour of history

# Wall-clock string accepted by App 2's ``time`` field: "HH:MM" or "HH:MM:SS".
# Rows for a pair with no stream carry ``time`` = "—" and must be skipped
# rather than guessed.
_HH_MM_RE = re.compile(r"^\d{1,2}:\d{2}(?::\d{2})?$")


@dataclass
class CachedSignal:
    pair: str  # canonical pair key
    signal: str  # "CALL" | "PUT"
    confidence: Optional[float]  # 0-1
    strength: Optional[str]
    candle_time: int  # unix seconds, minute-floored — the candle this signal PREDICTS
    first_seen_sec: int  # when we FIRST observed this candle's signal
    captured_at: float  # unix ms — used for TTL pruning
    last_tick_age_sec: Optional[float]
    live: bool
    buyer_pct: Optional[float]
    seller_pct: Optional[float]


@dataclass
class App2CacheState:
    # pair -> candleTime -> CachedSignal
    cache: Dict[str, Dict[int, CachedSignal]] = field(default_factory=dict)
    last_poll_at: float = 0.0
    last_poll_ok: bool = False
    last_error: Optional[str] = None
    last_raw_count: int = 0
    last_skipped: Dict[str, int] = field(default_factory=lambda: {"noPair": 0, "neutral": 0})
    poll_in_progress: bool = False
    task: Optional[asyncio.Task] = None  # background loop task


_state: Optional[App2CacheState] = None


def _get_state() -> App2CacheState:
    global _state
    if _state is None:
        _state = App2CacheState()
    return _state


def normalize_app2_row(row: dict, ref_sec: int) -> Optional[CachedSignal]:
    """Normalize one App 2 row into a cache entry.

    Exported so the aggregator and ``/api/diag`` parse App 2 rows through
    exactly the same code path.
    """
    pair = canonical_pair(pick_field(row, PAIR_KEYS))
    if not pair:
        return None

    signal = parse_direction(pick_field(row, DIRECTION_KEYS))
    if not signal:
        return None  # NEUTRAL / "—" / unknown

    # --- Candle ---------------------------------------------------------
    # App 2's ``time`` field is "HH:MM" UTC of the candle the signal is
    # predicting (post-update semantics — the old +1-candle shift is no longer
    # applied). ``resolve_clock_to_candle`` handles non-UTC timezones too.
    absolute = to_unix_seconds(
        pick_field(row, ["candle_time", "candleTime", "candle_ts", "entry_time", "entryTime"])
    )
    if absolute > 0:
        candle_time = candle_floor(absolute)
    else:
        time_str = str(pick_field(row, ["time", "candle", "clock"]) or "")
        if not _HH_MM_RE.match(time_str.strip()):
            return None
        candle_time = resolve_clock_to_candle(time_str, ref_sec)
    if not (candle_time and candle_time > 0):
        return None

    raw_conf = pick_field(row, ["confidence", "conf", "score"])
    conf_num = raw_conf if isinstance(raw_conf, (int, float)) else _try_float(raw_conf)
    confidence = None
    if conf_num is not None and math.isfinite(conf_num) and conf_num > 0:
        confidence = conf_num / 100 if conf_num > 1 else conf_num

    raw_strength = pick_field(row, ["strength", "quality"])
    strength = raw_strength.upper() if isinstance(raw_strength, str) else None

    # ``last_update`` is SECONDS AGO, not a unix timestamp. Reading it as an
    # absolute time produced a timestamp near the epoch, so every App 2 signal
    # looked ~56 years stale and was dropped — the direct cause of App 2's
    # empty column on the dashboard.
    raw_age = _try_float(pick_field(row, ["last_update", "lastUpdate", "age_sec"]))
    last_tick_age_sec = raw_age if (raw_age is not None and math.isfinite(raw_age) and raw_age >= 0) else None

    buyer = _try_float(pick_field(row, ["buyer_pct", "buyers", "buyerPct"]))
    seller = _try_float(pick_field(row, ["seller_pct", "sellers", "sellerPct"]))

    return CachedSignal(
        pair=pair,
        signal=signal,
        confidence=confidence,
        strength=strength,
        candle_time=candle_time,
        first_seen_sec=candle_time,  # prediction is generated at candle open
        captured_at=time.time() * 1000,
        last_tick_age_sec=last_tick_age_sec,
        live=bool(row.get("live") is True),
        buyer_pct=buyer if (buyer is not None and math.isfinite(buyer)) else None,
        seller_pct=seller if (seller is not None and math.isfinite(seller)) else None,
    )


def _try_float(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def _store_entry(st: App2CacheState, entry: CachedSignal) -> None:
    pair_cache = st.cache.setdefault(entry.pair, {})
    existing = pair_cache.get(entry.candle_time)
    if existing is None:
        pair_cache[entry.candle_time] = entry
        return
    # Keep the ORIGINAL first-seen time but refresh the payload — App 2
    # revises confidence and can flip direction mid-candle, and the freshest
    # read is the one it actually stands behind.
    entry.first_seen_sec = existing.first_seen_sec
    pair_cache[entry.candle_time] = entry


def record_app2_signals(entries: List[CachedSignal]) -> None:
    """Record already-normalized App 2 rows into the history cache.

    The aggregator calls this with every live snapshot it reads, so the cache
    has two independent writers. If the background poller stalls or was never
    started (a cold serverless instance), App 2 history still accumulates
    from ordinary dashboard traffic instead of silently staying empty.
    """
    st = _get_state()
    for entry in entries:
        _store_entry(st, entry)


async def _poll_app2() -> None:
    st = _get_state()
    if st.poll_in_progress:
        return
    st.poll_in_progress = True
    try:
        data = await fetch_json_with_timeout(APP2_URL, 8.0)
        rows = pick_array(data, ["rows", "signals", "data", "items"])
        if not rows:
            st.last_poll_ok = data is not None
            st.last_raw_count = 0
            st.last_error = "empty_response" if data is None else "no_rows"
        else:
            now = int(time.time())
            server_sec = to_unix_seconds(data.get("timestamp") or data.get("ts") or data.get("server_time")) if isinstance(data, dict) else 0
            # Prefer the upstream clock, but only if it is sane.
            ref_sec = server_sec if (server_sec > 0 and abs(server_sec - now) <= 300) else now

            skipped = {"noPair": 0, "neutral": 0}
            for row in rows:
                if not isinstance(row, dict):
                    continue
                entry = normalize_app2_row(row, ref_sec)
                if entry is None:
                    if not canonical_pair(pick_field(row, PAIR_KEYS)):
                        skipped["noPair"] += 1
                    else:
                        skipped["neutral"] += 1
                    continue
                _store_entry(st, entry)

            st.last_skipped = skipped
            st.last_raw_count = len(rows)
            st.last_poll_ok = True
            st.last_error = None

        # Prune entries older than CACHE_TTL_SEC, and drop empty pairs. Runs
        # every cycle — including when this poll returned no rows — so a
        # stretch of empty responses can't leave stale history un-pruned.
        cutoff = time.time() * 1000 - CACHE_TTL_SEC * 1000
        for pair, pair_cache in list(st.cache.items()):
            for ct, sig in list(pair_cache.items()):
                if sig.captured_at < cutoff:
                    pair_cache.pop(ct, None)
            if not pair_cache:
                st.cache.pop(pair, None)
    except Exception as e:
        st.last_poll_ok = False
        st.last_error = str(e) or type(e).__name__
        logger.error("[app2-cache] poll error: %s", st.last_error)
    finally:
        st.last_poll_at = time.time() * 1000
        st.poll_in_progress = False


async def _poll_loop() -> None:
    """Background loop — runs forever until cancelled on shutdown.

    ``asyncio.CancelledError`` is allowed to propagate so the lifespan
    shutdown hook can cleanly stop the loop.
    """
    while True:
        try:
            await _poll_app2()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # pragma: no cover — defensive
            logger.error("[app2-cache] loop iteration error: %s", e)
        await asyncio.sleep(POLL_INTERVAL_SEC)


def start_app2_cache_poller() -> None:
    """Start the background poller (idempotent). Safe to call many times."""
    st = _get_state()
    if st.task is not None and not st.task.done():
        return
    # Kick off the first poll immediately. The loop itself also runs an
    # initial poll, so we don't strictly need this fire-and-forget task, but
    # we keep it for fast boot responsiveness. We DON'T track it on st.task
    # (that slot is reserved for the loop task) — the loop will start its
    # own poll within milliseconds anyway.
    asyncio.create_task(_poll_app2())
    st.task = asyncio.create_task(_poll_loop())
    logger.info("[app2-cache] started — polling every %.1fs", POLL_INTERVAL_SEC)


async def poll_app2_now() -> None:
    """Force one immediate poll and wait for it."""
    await _poll_app2()


def get_app2_cached_signal(pair: str, candle_time: int) -> Optional[CachedSignal]:
    st = _get_state()
    pair_cache = st.cache.get(canonical_pair(pair))
    if not pair_cache:
        return None
    return pair_cache.get(candle_floor(candle_time))


def get_app2_cached_signals_for_pair(pair: str) -> List[CachedSignal]:
    st = _get_state()
    pair_cache = st.cache.get(canonical_pair(pair))
    if not pair_cache:
        return []
    return list(pair_cache.values())


def get_all_cached_app2_signals() -> List[CachedSignal]:
    st = _get_state()
    out: List[CachedSignal] = []
    for pc in st.cache.values():
        out.extend(pc.values())
    return out


def get_all_cached_app2_pairs() -> List[str]:
    return list(_get_state().cache.keys())


def get_app2_cache_size() -> int:
    return sum(len(pc) for pc in _get_state().cache.values())


def reset_app2_cache_for_tests() -> None:
    """Drop every cached candle. Test-only — the cache is a process-wide
    singleton, so tests would otherwise leak state into each other."""
    st = _get_state()
    st.cache.clear()


def get_app2_cache_stats() -> dict:
    st = _get_state()
    return {
        "running": st.task is not None and not st.task.done(),
        "lastPollAt": st.last_poll_at,
        "lastPollAgeMs": int(time.time() * 1000 - st.last_poll_at) if st.last_poll_at > 0 else -1,
        "lastPollOk": st.last_poll_ok,
        "lastError": st.last_error,
        "lastRawCount": st.last_raw_count,
        "lastSkipped": st.last_skipped,
        "pairs": len(st.cache),
        "entries": get_app2_cache_size(),
    }
