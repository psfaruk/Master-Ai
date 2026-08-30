"""App 2 Historical Signal Cache.

App 2's ``/api/share-signals`` only returns the CURRENT candle's snapshot.
Once a new candle starts, the previous signal is gone. To build a proper
candle-aligned consensus across the 3 apps, we need App 2's signal for each
historical candle — not just the current one.

This module polls App 2 every ``POLL_INTERVAL_SEC`` seconds (default 8s) in
the background and stores, for each ``(pair, candleMinute)``, the signal
App 2 produced. The aggregator then reads from this cache to align with
App 1 and App 3.

The cache is in-memory but PERSISTED to a JSON file so history survives
process restarts (previously a deploy/restart wiped App 2's history and the
backtest's 2-agree/3-agree win rates went dark until the cache rebuilt over
hours). It keeps the last ``CACHE_TTL_SEC`` of history (currently 7 hours,
sized to comfortably cover the 6-hour backtest lookback window plus a
buffer). The persistence layer only activates once the poller is started
(``start_app2_cache_poller``), so tests that drive the cache directly never
touch the disk. It lives on a module-level singleton — the asyncio task is
started idempotently so multiple route handlers can call
``start_app2_cache_poller()`` without spinning up duplicate intervals.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .http_fetcher import fetch_json_with_timeout
from .source_config import resolve_source_url
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

# The App 2 endpoint URL is resolved at poll time through source_config.py,
# so a redeployed Railway app can be repointed from the dashboard without a
# code change. This constant remains as the documented built-in default.
APP2_URL = "https://binary-signals-app-production.up.railway.app/api/share-signals"
POLL_INTERVAL_SEC = 8.0
# Keep at least LOOKBACK_SEC + 1h of history so the 6-hour backtest actually
# has App 2 data to grade across the full window. App 2 has no historical
# endpoint — this in-memory cache is the ONLY source of past App 2 candles.
# Previously 1h, which silently truncated the backtest's App 2 stats to
# ~1h of data and produced misleading per-pair win rates (REVIEW-1 C4).
CACHE_TTL_SEC = 7 * 60 * 60

# Minimum interval between disk saves. ``record_app2_signals`` is called on
# every snapshot poll (up to ~1/s during the candle-open burst); without a
# debounce the JSON file would be rewritten that often.
DISK_SAVE_MIN_INTERVAL_SEC = 5.0

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
    # Set while a poll is running; other callers of poll_app2_now() wait on
    # it instead of silently returning with pre-poll state (mirrors
    # snapshot_poller._poll_once's event pattern).
    poll_done_event: Optional[asyncio.Event] = None
    task: Optional[asyncio.Task] = None  # background loop task
    # Initial kick-off poll — tracked so lifespan shutdown can cancel it
    # (previously fire-and-forget, leaked on shutdown). (REVIEW-1 H7.)
    initial_task: Optional[asyncio.Task] = None
    # ---- Disk persistence (activated by start_app2_cache_poller) ----
    disk_path: Optional[str] = None  # None = persistence off (e.g. tests)
    dirty: bool = False  # cache changed since the last disk save
    last_disk_save_at: float = 0.0


_state: Optional[App2CacheState] = None


def _get_state() -> App2CacheState:
    global _state
    if _state is None:
        _state = App2CacheState()
    return _state


def _disk_path() -> str:
    """JSON file the App 2 history cache is persisted to.

    Overridable via ``APP2_CACHE_FILE`` (Railway env). Defaults to
    ``<repo>/data/app2_cache.json`` — the Dockerfile runs as the ``app``
    user with a writable /app, so this works on Railway without extra
    volume config.
    """
    env = os.environ.get("APP2_CACHE_FILE", "").strip()
    if env:
        return env
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "data", "app2_cache.json")


# Fields of CachedSignal that round-trip through the JSON file.
_DISK_FIELDS = (
    "pair", "signal", "confidence", "strength", "candle_time",
    "first_seen_sec", "captured_at", "last_tick_age_sec", "live",
    "buyer_pct", "seller_pct",
)


def _load_disk_cache(st: App2CacheState) -> None:
    """Restore previously-saved history into the in-memory cache.

    Entries older than ``CACHE_TTL_SEC`` are dropped on load. Malformed
    rows are skipped rather than raising — a half-written file must not
    take the poller down.
    """
    path = st.disk_path
    if not path or not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        logger.warning("[app2-cache] disk cache load failed: %s", e)
        return
    if not isinstance(raw, list):
        logger.warning("[app2-cache] disk cache has unexpected shape — ignoring")
        return

    cutoff = time.time() * 1000 - CACHE_TTL_SEC * 1000
    loaded = 0
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            sig = CachedSignal(**{k: item.get(k) for k in _DISK_FIELDS})
        except TypeError:
            continue
        # Type-guard the numeric comparisons too — a hand-edited or legacy
        # row with candle_time="1700000000" (str) or captured_at=None used to
        # raise TypeError OUTSIDE the constructor's try, escaping this loader
        # and poisoning the first snapshot poll after boot.
        try:
            if (
                not sig.pair or not sig.signal
                or not (isinstance(sig.candle_time, int) and not isinstance(sig.candle_time, bool) and sig.candle_time > 0)
                or not (isinstance(sig.captured_at, (int, float)) and not isinstance(sig.captured_at, bool) and sig.captured_at >= cutoff)
            ):
                continue
        except TypeError:
            continue
        pair_cache = st.cache.setdefault(sig.pair, {})
        existing = pair_cache.get(sig.candle_time)
        if existing is None or sig.captured_at > existing.captured_at:
            pair_cache[sig.candle_time] = sig
        loaded += 1
    if loaded:
        logger.info("[app2-cache] restored %d history entries from %s", loaded, path)


def _save_disk_cache(st: App2CacheState) -> None:
    """Write the whole cache to the JSON file atomically (tmp + rename).

    No-op when persistence is off (``disk_path`` is None) or nothing
    changed since the last write.
    """
    path = st.disk_path
    if not path or not st.dirty:
        return
    now = time.time()
    if now - st.last_disk_save_at < DISK_SAVE_MIN_INTERVAL_SEC:
        return

    # Prune before writing so the file never grows past the TTL window.
    cutoff = now * 1000 - CACHE_TTL_SEC * 1000
    for pair, pair_cache in list(st.cache.items()):
        for ct, sig in list(pair_cache.items()):
            if sig.captured_at < cutoff:
                pair_cache.pop(ct, None)
        if not pair_cache:
            st.cache.pop(pair, None)

    payload = [
        {k: getattr(sig, k) for k in _DISK_FIELDS}
        for pc in st.cache.values() for sig in pc.values()
    ]
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        os.replace(tmp, path)
        st.dirty = False
        st.last_disk_save_at = now
    except OSError as e:
        logger.warning("[app2-cache] disk cache save failed: %s", e)


def save_app2_cache_now() -> None:
    """Force a disk write now (bypassing the debounce). Used by the lifespan
    shutdown hook so the last poll's entries aren't lost on exit."""
    st = _get_state()
    if not st.disk_path or not st.dirty:
        return
    st.last_disk_save_at = 0.0  # defeat the debounce
    _save_disk_cache(st)


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
        st.dirty = True
        return
    # Keep the ORIGINAL first-seen time but refresh the payload — App 2
    # revises confidence and can flip direction mid-candle, and the freshest
    # read is the one it actually stands behind. captured_at is refreshed
    # every poll, so any update marks the cache dirty for persistence.
    entry.first_seen_sec = existing.first_seen_sec
    st.dirty = True
    pair_cache[entry.candle_time] = entry


def record_app2_signals(entries: List[CachedSignal]) -> None:
    """Record already-normalized App 2 rows into the history cache.

    The aggregator calls this with every live snapshot it reads, so the cache
    has two independent writers. If the background poller stalls or was never
    started (a cold serverless instance), App 2 history still accumulates
    from ordinary dashboard traffic instead of silently staying empty.

    Also persists to disk (debounced) when persistence is enabled.
    """
    st = _get_state()
    for entry in entries:
        _store_entry(st, entry)
    _save_disk_cache(st)


async def _poll_app2() -> None:
    st = _get_state()
    if st.poll_in_progress:
        # A poll is already running. Wait for THAT one to finish instead of
        # returning immediately — callers of poll_app2_now() (/api/diag?poll=1,
        # the post-save reconnect kick) specifically want the FRESH state.
        if st.poll_done_event is not None:
            await st.poll_done_event.wait()
        return
    st.poll_in_progress = True
    st.poll_done_event = asyncio.Event()
    try:
        try:
            data = await fetch_json_with_timeout(resolve_source_url("app2", "signals"), 8.0)
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

                skipped = {"noPair": 0, "neutral": 0, "noCandle": 0}
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    entry = normalize_app2_row(row, ref_sec)
                    if entry is None:
                        # Distinguish the skip reason — "noCandle" (an
                        # unparseable / "—" time field) used to be counted
                        # under "neutral", hiding the real cause.
                        if not canonical_pair(pick_field(row, PAIR_KEYS)):
                            skipped["noPair"] += 1
                        elif not parse_direction(pick_field(row, DIRECTION_KEYS)):
                            skipped["neutral"] += 1
                        else:
                            skipped["noCandle"] += 1
                        continue
                    _store_entry(st, entry)

                st.last_skipped = skipped
                st.last_raw_count = len(rows)
                st.last_poll_ok = True
                st.last_error = None
        except Exception as e:
            st.last_poll_ok = False
            st.last_error = str(e) or type(e).__name__
            logger.error("[app2-cache] poll error: %s", st.last_error)

        # Prune entries older than CACHE_TTL_SEC, and drop empty pairs. Runs
        # every cycle — including when this poll returned no rows AND when
        # the fetch above raised outright (a network blip, or the upstream's
        # own redeploy window — exactly the condition this cache exists to
        # ride out) — so neither an empty response nor a hard fetch failure
        # can leave stale history un-pruned for as long as that keeps
        # happening.
        cutoff = time.time() * 1000 - CACHE_TTL_SEC * 1000
        for pair, pair_cache in list(st.cache.items()):
            for ct, sig in list(pair_cache.items()):
                if sig.captured_at < cutoff:
                    pair_cache.pop(ct, None)
            if not pair_cache:
                st.cache.pop(pair, None)

        # Persist (debounced) so restarts don't lose the history the
        # backtest depends on.
        _save_disk_cache(st)
    finally:
        st.last_poll_at = time.time() * 1000
        st.poll_in_progress = False
        st.poll_done_event.set()


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
    """Start the background poller (idempotent). Safe to call many times.

    Also activates disk persistence: restores any previously-saved history
    so a restart doesn't blank the backtest's App 2 data."""
    st = _get_state()
    if st.disk_path is None:
        st.disk_path = _disk_path()
        _load_disk_cache(st)
    if st.task is not None and not st.task.done():
        return
    # Kick off the first poll immediately. Track it so lifespan shutdown can
    # cancel it cleanly (previously fire-and-forget — REVIEW-1 H7).
    st.initial_task = asyncio.create_task(_poll_app2())
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
    st.dirty = False


def reset_app2_history() -> None:
    """Public alias of ``reset_app2_cache_for_tests`` for production use.

    Called by POST /api/sources when the App 2 URL changes and the user
    opts to purge history collected from the PREVIOUS upstream — after a
    redeploy the old rows are still valid App 2 history, but if the new
    URL points at a DIFFERENT app the stale rows would poison the
    consensus.
    """
    reset_app2_cache_for_tests()


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
