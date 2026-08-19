"""Signal Aggregator.

Fetches CALL/PUT signals from three Quotex signal apps hosted on Railway,
normalizes them into a unified schema, and computes per-pair consensus
(2-bot agree / 3-bot agree / conflict / single).

Why a server-side aggregator: all 3 source apps lack CORS headers, so the
browser cannot call them directly. We fan out server-side.

Alignment rules (see ``signal_normalize.py`` for the primitives):

- Every pair name goes through ``canonical_pair()`` so App 1's ``symbol``,
  App 2's ``pair`` and App 3's ``asset`` land on the SAME dict key.
- Every timestamp goes through ``to_unix_seconds()`` so a millisecond field
  can't push a candle 50,000 years into the future.
- Consensus is computed per (pair, candle). A signal counts for a candle
  when it was emitted in time for that candle — NOT when it happens to be
  younger than N minutes relative to now.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .app2_cache import (
    CachedSignal,
    get_all_cached_app2_pairs,
    get_app2_cached_signals_for_pair,
    normalize_app2_row,
    record_app2_signals,
    start_app2_cache_poller,
)
from .http_fetcher import fetch_json_with_timeout
from .signal_normalize import (
    CANDLE_SEC,
    DIRECTION_KEYS,
    PAIR_KEYS,
    AppId,
    Direction,
    canonical_pair,
    candle_floor,
    classify_pair,
    display_pair_from_asset,
    get_candle_offset_sec,
    is_signal_valid_for_candle,
    parse_direction,
    pick_array,
    pick_field,
    to_unix_seconds,
)

logger = logging.getLogger("master-ai.signal_aggregator")

FETCH_TIMEOUT_SEC = 10.0

ConsensusLevel = str  # "3-agree" | "2-agree" | "conflict" | "1-only" | "none"


@dataclass
class SourceSignal:
    source: AppId
    source_name: str
    pair: str  # canonical asset code, e.g. "USDCOP_otc"
    display_pair: str  # e.g. "USD/COP OTC"
    direction: Direction
    confidence: Optional[float]
    strength: Optional[str] = None
    timestamp: int = 0  # unix seconds — when the app emitted the signal
    candle_time: int = 0  # unix seconds, minute-floored
    age_sec: int = 0
    outcome: Optional[str] = None  # "WIN"|"LOSS"|"DRAW"|"CORRECT"|"WRONG"|None
    strategy: Optional[str] = None
    reasons: Optional[List[str]] = None
    valid_for_candle: bool = False
    fresh: bool = False
    cached: bool = False  # True when this App 2 signal came from history cache


@dataclass
class Consensus:
    level: ConsensusLevel
    direction: Optional[Direction]
    agreeing_apps: List[AppId] = field(default_factory=list)
    disagreeing_apps: List[AppId] = field(default_factory=list)
    missing_apps: List[AppId] = field(default_factory=list)
    invalid_apps: List[AppId] = field(default_factory=list)


@dataclass
class CandleConsensus:
    pair: str
    display_pair: str
    category: str  # "otc" | "real"
    candle_time: int
    signals: List[SourceSignal]
    fresh_count: int
    call_count: int
    put_count: int
    neutral_count: int
    consensus: Consensus


@dataclass
class PairConsensus:
    pair: str
    display_pair: str
    category: str  # "otc" | "real"
    signals: List[SourceSignal]  # latest signal from each app
    candles: List[CandleConsensus]
    latest_candle: Optional[CandleConsensus]
    fresh_count: int
    call_count: int
    put_count: int
    neutral_count: int
    consensus: Consensus


@dataclass
class AppStatus:
    id: AppId
    name: str
    url: str
    online: bool
    last_checked: int  # unix ms
    signal_count: int
    fresh_signal_count: int
    health: str  # "ok"|"token_expired"|"disconnected"|"down"|"unknown"
    detail: Optional[str] = None
    live: Optional[bool] = None
    token_expired: Optional[bool] = None
    latency_ms: Optional[int] = None
    uptime_sec: Optional[int] = None
    active_streams: Optional[int] = None
    raw_count: Optional[int] = None
    skipped: Optional[Dict[str, int]] = None
    error: Optional[str] = None


@dataclass
class AggregatedResponse:
    timestamp: int  # unix ms (server time when aggregation ran)
    freshness_window_sec: int
    apps: List[AppStatus]
    pairs: List[PairConsensus]
    summary: Dict[str, Any]


# ---------------------------------------------------------------------------
# Source app definitions
# ---------------------------------------------------------------------------

SOURCES: List[Dict[str, Any]] = [
    {
        "id": "app1",
        "name": "Minimum Pair",
        "short_name": "App 1",
        "base_url": "https://minimum-pair-production.up.railway.app",
        # New Minimum Pair app (FastAPI). /api/history returns a bare JSON
        # array of recent signals across ALL pairs. We pull a generous limit
        # so the candle-aligned consensus has enough history.
        "signals_path": "/api/history?limit=500",
        "health_path": "/api/status",
        "accent": "amber",
    },
    {
        "id": "app2",
        "name": "Binary Signal Terminal",
        "short_name": "App 2",
        "base_url": "https://binary-signals-app-production.up.railway.app",
        "signals_path": "/api/share-signals",
        "health_path": "/api/status",
        "accent": "violet",
    },
    {
        "id": "app3",
        "name": "OTC Live Trading",
        "short_name": "App 3",
        "base_url": "https://otclivedata.up.railway.app",
        "signals_path": "/api/share-signals",
        "historical_path": "/api/signals?limit=300",
        "health_path": "/api/token-status",
        "accent": "emerald",
    },
]


def get_sources() -> List[Dict[str, Any]]:
    return SOURCES


# ---------------------------------------------------------------------------
# Normalize result container
# ---------------------------------------------------------------------------


@dataclass
class NormalizeResult:
    signals: List[SourceSignal] = field(default_factory=list)
    health: str = "unknown"
    detail: Optional[str] = None
    live: Optional[bool] = None
    token_expired: Optional[bool] = None
    uptime_sec: Optional[int] = None
    active_streams: Optional[int] = None
    raw_count: int = 0
    skipped: Dict[str, int] = field(default_factory=lambda: {"noPair": 0, "noDirection": 0, "noCandle": 0})
    latency_ms: Optional[int] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Health endpoint callers
# ---------------------------------------------------------------------------


async def _fetch_app1_health() -> Dict[str, Any]:
    src = SOURCES[0]
    try:
        d = await fetch_json_with_timeout(f"{src['base_url']}{src['health_path']}", 6.0)
        if not d:
            return {"error": "empty_health"}
        connected = d.get("quotex_connected") is True
        err_msg = d.get("error") if isinstance(d.get("error"), str) and d.get("error") else None
        active_pairs = d.get("active_pairs") if isinstance(d.get("active_pairs"), list) else []

        # The new app does not expose a token-expired flag directly. When it uses
        # session_token auth and is NOT connected without an explicit error
        # message, the most likely root cause is an expired/rejected session
        # token — surface that as "token_expired" so the dashboard shows the
        # amber "token expired" pill instead of a generic "disconnected".
        token_expired = (not connected) and d.get("auth_mode") == "session_token" and not err_msg

        if connected:
            health = "ok"
        elif token_expired:
            health = "token_expired"
        else:
            health = "disconnected"

        parts = []
        if connected:
            parts.append(f"live · {len(active_pairs)} pairs")
        elif token_expired:
            parts.append("session token expired")
        elif err_msg:
            parts.append(err_msg)
        else:
            parts.append("connecting…")
        if d.get("auth_mode"):
            parts.append(f"auth={d['auth_mode']}")

        return {
            "health": health,
            "live": connected,
            "token_expired": token_expired,
            "active_streams": len(active_pairs),
            "detail": " · ".join(parts),
        }
    except Exception:
        return {"error": "health_fetch_failed"}


async def _fetch_app2_health() -> Dict[str, Any]:
    src = SOURCES[1]
    try:
        d = await fetch_json_with_timeout(f"{src['base_url']}{src['health_path']}", 6.0)
        if not d:
            return {"error": "empty_health"}
        connected = d.get("connected") is True
        streams = d.get("streams", {}).get("active", []) if isinstance(d.get("streams"), dict) else []
        health = "ok" if connected else "disconnected"
        return {
            "health": health,
            "live": connected,
            "token_expired": False,
            "active_streams": len(streams),
            "detail": f"connected · {len(streams)} streams" if connected else "disconnected",
        }
    except Exception:
        return {"error": "health_fetch_failed"}


async def _fetch_app3_health() -> Dict[str, Any]:
    src = SOURCES[2]
    try:
        d = await fetch_json_with_timeout(f"{src['base_url']}{src['health_path']}", 6.0)
        if not d:
            return {"error": "empty_health"}
        connected = d.get("connected") is True
        has_token = d.get("has_env_token") is True or d.get("has_user_token") is True
        if not has_token:
            health = "token_expired"
        elif not connected:
            health = "disconnected"
        else:
            health = "ok"
        detail = None
        if d.get("token_source"):
            detail = f"token_source={d['token_source']}{' · connected' if connected else ' · disconnected'}"
        return {
            "health": health,
            "live": connected,
            "token_expired": not has_token,
            "detail": detail,
        }
    except Exception:
        return {"error": "health_fetch_failed"}


HEALTH_FETCHERS = {
    "app1": _fetch_app1_health,
    "app2": _fetch_app2_health,
    "app3": _fetch_app3_health,
}


def _merge_health(sig_result: NormalizeResult, health_result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Merge health-endpoint data into the signals-fetcher result.

    Health data wins for online/token state because it's authoritative. If the
    signals fetch failed but health succeeded, we still report the app as
    online. If health also failed, we fall back to the signals fetch state.
    """
    if not health_result or health_result.get("error"):
        if sig_result.health == "down":
            return {
                "health": "down",
                "detail": sig_result.error or "signals + health fetch failed",
                "live": False,
                "token_expired": False,
            }
        return {
            "health": sig_result.health,
            "detail": sig_result.detail or "health check failed (signals OK)",
            "live": sig_result.health == "ok",
            "token_expired": sig_result.health == "token_expired",
        }
    return {
        "health": health_result.get("health", sig_result.health),
        "detail": health_result.get("detail", sig_result.detail),
        "live": health_result.get("live"),
        "token_expired": health_result.get("token_expired"),
        "uptime_sec": health_result.get("uptime_sec"),
        "active_streams": health_result.get("active_streams"),
    }


# ---------------------------------------------------------------------------
# Per-source fetch + normalize
# ---------------------------------------------------------------------------


def _make_signal(
    base: Dict[str, Any],
    now: int,
    freshness_window_sec: int,
) -> SourceSignal:
    """Build a SourceSignal, filling in the derived fields consistently."""
    timestamp = int(base.get("timestamp", 0) or 0)
    age_sec = max(0, now - timestamp)
    candle_time = int(base.get("candle_time", 0) or 0)
    # APPx_CANDLE_OFFSET is baked into candle_time so all 3 apps bucket into
    # the SAME candle for cross-app consensus — it has nothing to do with
    # whether the signal was emitted at a sane time relative to what it
    # predicts. Validating "is this a legitimate signal for its candle"
    # against the SHIFTED candle_time means a negative offset (a supported,
    # documented value — /api/diag itself recommends setting one) pushes
    # `lead` past -MAX_LAG_SEC and marks every one of that app's signals
    # invalid, silently dropping it from consensus. Callers pass the
    # pre-offset candle time here; callers that don't (offset == 0) get
    # byte-for-byte the old behavior since raw_candle_time defaults to
    # candle_time itself.
    raw_candle_time = int(base.get("raw_candle_time", candle_time) or 0)
    return SourceSignal(
        source=base["source"],
        source_name=base["source_name"],
        pair=base["pair"],
        display_pair=display_pair_from_asset(base["pair"]),
        direction=base["direction"],
        confidence=base.get("confidence"),
        strength=base.get("strength"),
        timestamp=timestamp,
        candle_time=candle_time,
        age_sec=age_sec,
        outcome=base.get("outcome"),
        strategy=base.get("strategy"),
        reasons=base.get("reasons"),
        valid_for_candle=is_signal_valid_for_candle(timestamp, raw_candle_time),
        fresh=age_sec <= freshness_window_sec,
        cached=base.get("cached", False),
    )


async def fetch_app1(freshness_window_sec: int, now: int) -> NormalizeResult:
    """App 1 (Minimum Pair — FastAPI edition): GET /api/history?limit=N.

    Returns a BARE JSON ARRAY of recent signals across all tracked pairs. Each
    row has shape::

        { id, pair, direction, created_at, entry_ts, target_close_ts,
          confidence, source, entry_price, close_price, result }
    """
    src = SOURCES[0]
    skipped = {"noPair": 0, "noDirection": 0, "noCandle": 0}
    try:
        data = await fetch_json_with_timeout(f"{src['base_url']}{src['signals_path']}", FETCH_TIMEOUT_SEC)
    except Exception:
        return NormalizeResult(signals=[], health="down", skipped=skipped, error="fetch_failed")
    if not data:
        return NormalizeResult(signals=[], health="down", skipped=skipped, error="empty_response")

    arr = pick_array(data, ["history", "signals", "rows", "data"])
    offset = get_candle_offset_sec("app1")
    out: List[SourceSignal] = []

    for s in arr:
        if not isinstance(s, dict):
            continue
        pair = canonical_pair(pick_field(s, PAIR_KEYS))
        if not pair:
            skipped["noPair"] += 1
            continue
        direction = parse_direction(pick_field(s, DIRECTION_KEYS))
        if not direction:
            skipped["noDirection"] += 1
            continue

        entry_sec = to_unix_seconds(pick_field(s, ["entry_ts", "entryTime", "entry_time", "candleTime", "ctime"]))
        if not (entry_sec > 0):
            skipped["noCandle"] += 1
            continue
        raw_candle_time = candle_floor(entry_sec)
        candle_time = raw_candle_time + offset

        emitted_at = to_unix_seconds(pick_field(s, ["created_at", "signalAt", "signal_at", "createdAt", "ts"]))
        ts = emitted_at if emitted_at > 0 else candle_time

        conf_raw = s.get("confidence") if isinstance(s.get("confidence"), (int, float)) else None
        confidence = conf_raw if (conf_raw is not None and conf_raw > 0) else None

        raw_result = str(s.get("result")) if s.get("result") else None
        raw_status = str(s.get("status")) if s.get("status") else None
        raw_outcome = raw_result or raw_status
        outcome_up = raw_outcome.upper() if raw_outcome else None
        outcome: Optional[str] = None
        if outcome_up in ("WIN", "CORRECT"):
            outcome = "WIN"
        elif outcome_up in ("LOSS", "WRONG"):
            outcome = "LOSS"
        elif outcome_up in ("DRAW", "VOID"):
            outcome = "DRAW"

        strategy_raw = None
        if isinstance(s.get("source"), str) and s.get("source"):
            strategy_raw = s.get("source")
        elif isinstance(s.get("primaryPattern"), str) and s.get("primaryPattern"):
            strategy_raw = s.get("primaryPattern")

        quality = pick_field(s, ["quality"])
        quality_num = quality if isinstance(quality, (int, float)) else None
        strength_base = quality_num if (quality_num and quality_num > 0) else (confidence or 0)
        strength = "STRONG" if strength_base >= 0.7 else "MEDIUM" if strength_base >= 0.45 else "WEAK"

        reasons = s.get("reasons") if isinstance(s.get("reasons"), list) else None

        out.append(_make_signal({
            "source": "app1",
            "source_name": src["name"],
            "pair": pair,
            "direction": direction,
            "confidence": confidence,
            "strength": strength,
            "timestamp": ts,
            "candle_time": candle_time,
            "raw_candle_time": raw_candle_time,
            "outcome": outcome,
            "strategy": strategy_raw,
            "reasons": reasons,
        }, now, freshness_window_sec))

    return NormalizeResult(signals=out, health="ok", raw_count=len(arr), skipped=skipped)


def _app2_cached_to_signal(
    c: CachedSignal,
    src_name: str,
    now: int,
    freshness_window_sec: int,
    offset: int,
) -> SourceSignal:
    candle_time = c.candle_time + offset
    strategy: Optional[str] = None
    if c.buyer_pct is not None and c.seller_pct is not None and math.isfinite(c.buyer_pct) and math.isfinite(c.seller_pct):
        # Match the original TS formatting (integers shown as "63", not "63.0").
        b = int(c.buyer_pct) if c.buyer_pct == int(c.buyer_pct) else c.buyer_pct
        s = int(c.seller_pct) if c.seller_pct == int(c.seller_pct) else c.seller_pct
        strategy = f"buyers={b}% sellers={s}%"
    elif c.strength is not None:
        strategy = c.strength

    reasons: Optional[List[str]] = None
    if c.last_tick_age_sec is not None and c.last_tick_age_sec > 120:
        reasons = [f"App 2 stream stale — last tick {round(c.last_tick_age_sec)}s ago"]

    return _make_signal({
        "source": "app2",
        "source_name": src_name,
        "pair": c.pair,
        "direction": c.signal,
        "confidence": c.confidence,
        "strength": c.strength,
        "timestamp": c.first_seen_sec if c.first_seen_sec > 0 else candle_time,
        "candle_time": candle_time,
        "raw_candle_time": c.candle_time,
        "outcome": None,
        "strategy": strategy,
        "reasons": reasons,
        "cached": True,
    }, now, freshness_window_sec)


async def fetch_app2(freshness_window_sec: int, now: int) -> NormalizeResult:
    """App 2 (Binary Signal Terminal): /api/share-signals -> {rows: [...]}.

    The endpoint returns a SNAPSHOT of all pairs with their CURRENT candle's
    signal only — once a new candle starts the previous one is gone. So we
    merge two sources: the live snapshot (authoritative for the current
    candle) and our own historical cache (app2_cache.py), which has been
    recording each candle's signal every 5s.
    """
    start_app2_cache_poller()

    src = SOURCES[1]
    offset = get_candle_offset_sec("app2")
    skipped = {"noPair": 0, "noDirection": 0, "noCandle": 0}
    fetch_failed = False
    data: Any = None

    try:
        data = await fetch_json_with_timeout(f"{src['base_url']}{src['signals_path']}", FETCH_TIMEOUT_SEC)
        if data is None:
            fetch_failed = True
    except Exception:
        fetch_failed = True

    arr = [] if fetch_failed else pick_array(data, ["rows", "signals", "data", "items"])
    server_sec = 0
    if isinstance(data, dict):
        server_sec = to_unix_seconds(data.get("timestamp") or data.get("ts") or data.get("server_time"))
    ref_sec = server_sec if (server_sec > 0 and abs(server_sec - now) <= 300) else now

    out: List[SourceSignal] = []
    seen_candles: set = set()  # "pair|candleTime"

    # 1. Live snapshot — authoritative for the current candle.
    live_entries: List[CachedSignal] = []
    for row in arr:
        if not isinstance(row, dict):
            continue
        entry = normalize_app2_row(row, ref_sec)
        if entry is None:
            if not canonical_pair(pick_field(row, PAIR_KEYS)):
                skipped["noPair"] += 1
            else:
                skipped["noDirection"] += 1
            continue
        live_entries.append(entry)
        sig = _app2_cached_to_signal(entry, src["name"], now, freshness_window_sec, offset)
        sig.cached = False
        seen_candles.add(f"{sig.pair}|{sig.candle_time}")
        out.append(sig)
    # Feed the history cache from here too, so App 2's past candles survive
    # even if the background poller isn't running in this process.
    if live_entries:
        record_app2_signals(live_entries)

    # 2. Historical cache — every candle the snapshot no longer shows.
    all_pairs = {s.pair for s in out}
    all_pairs.update(get_all_cached_app2_pairs())

    for pair in all_pairs:
        for c in get_app2_cached_signals_for_pair(pair):
            sig = _app2_cached_to_signal(c, src["name"], now, freshness_window_sec, offset)
            key = f"{sig.pair}|{sig.candle_time}"
            if key in seen_candles:
                continue  # live snapshot wins
            seen_candles.add(key)
            out.append(sig)

    if fetch_failed:
        health = "disconnected" if out else "down"
    elif isinstance(data, dict) and data.get("connected") is False:
        health = "disconnected"
    else:
        health = "ok"

    detail = "live snapshot failed — serving cached candles" if (fetch_failed and out) else None

    return NormalizeResult(
        signals=out,
        health=health,
        raw_count=len(arr),
        skipped=skipped,
        error="fetch_failed" if fetch_failed else None,
        detail=detail,
    )


async def fetch_app3(freshness_window_sec: int, now: int) -> NormalizeResult:
    """App 3 (OTC Live Trading): /api/share-signals (current) + /api/signals?limit=N.

    1. /api/share-signals — the CURRENT candle's live signal per pair.
    2. /api/signals?limit=N — RESOLVED historical signals (candle closed,
       result known: correct/wrong/draw).

    Merged and deduped by (pair, candleTime); the historical row wins because
    it carries a resolved outcome.
    """
    src = SOURCES[2]
    offset = get_candle_offset_sec("app3")
    skipped = {"noPair": 0, "noDirection": 0, "noCandle": 0}
    out: List[SourceSignal] = []
    seen_candles: set = set()
    health = "ok"
    raw_count = 0
    hist_ok = False
    live_ok = False

    # --- 1. RESOLVED historical signals (carry WIN/LOSS outcomes) ---
    hist_path = src.get("historical_path", "/api/signals?limit=300")
    try:
        hist_data = await fetch_json_with_timeout(f"{src['base_url']}{hist_path}", FETCH_TIMEOUT_SEC)
        if hist_data:
            hist_ok = True
            arr = pick_array(hist_data, ["signals", "rows", "data"])
            raw_count = len(arr)
            for s in arr:
                if not isinstance(s, dict):
                    continue
                pair = canonical_pair(pick_field(s, PAIR_KEYS))
                if not pair:
                    skipped["noPair"] += 1
                    continue
                direction = parse_direction(pick_field(s, DIRECTION_KEYS))
                if not direction:
                    skipped["noDirection"] += 1
                    continue
                ctime = to_unix_seconds(pick_field(s, ["ctime", "candle_time", "time", "ts"]))
                if not (ctime > 0):
                    skipped["noCandle"] += 1
                    continue
                raw_candle_time = candle_floor(ctime)
                candle_time = raw_candle_time + offset
                conf_raw = s.get("confidence") if isinstance(s.get("confidence"), (int, float)) else None
                hist_conf = conf_raw if (conf_raw and conf_raw > 0) else None
                result = str(pick_field(s, ["result", "outcome", "status"]) or "").lower()
                outcome: Optional[str] = None
                if result in ("correct", "win"):
                    outcome = "CORRECT"
                elif result in ("wrong", "loss"):
                    outcome = "WRONG"
                elif result == "draw":
                    outcome = "DRAW"
                strength = s.get("strength") if isinstance(s.get("strength"), str) else None
                codes = s.get("codes") if isinstance(s.get("codes"), str) and s.get("codes") else None
                seen_candles.add(f"{pair}|{candle_time}")
                out.append(_make_signal({
                    "source": "app3",
                    "source_name": src["name"],
                    "pair": pair,
                    "direction": direction,
                    "confidence": hist_conf,
                    "strength": strength,
                    "timestamp": ctime,
                    "candle_time": candle_time,
                    "raw_candle_time": raw_candle_time,
                    "outcome": outcome,
                    "strategy": codes,
                    "reasons": None,
                }, now, freshness_window_sec))
    except Exception:
        # Historical fetch failed — keep going, we still want the live signals.
        pass

    # --- 2. CURRENT live signals from /api/share-signals ---
    try:
        live_data = await fetch_json_with_timeout(f"{src['base_url']}{src['signals_path']}", FETCH_TIMEOUT_SEC)
        if live_data:
            live_ok = True
            live_arr = pick_array(live_data, ["signals", "rows", "data"])
            for r in live_arr:
                if not isinstance(r, dict):
                    continue
                pair = canonical_pair(pick_field(r, PAIR_KEYS))
                if not pair:
                    skipped["noPair"] += 1
                    continue
                direction = parse_direction(pick_field(r, DIRECTION_KEYS))
                if not direction:
                    skipped["noDirection"] += 1
                    continue
                t = to_unix_seconds(pick_field(r, ["time", "candle_time", "ctime", "ts"]))
                raw_candle_time = candle_floor(t) if t > 0 else candle_floor(now)
                candle_time = raw_candle_time + offset
                key = f"{pair}|{candle_time}"
                if key in seen_candles:
                    continue  # historical already has this candle
                seen_candles.add(key)
                conf_raw = r.get("confidence") if isinstance(r.get("confidence"), (int, float)) else None
                live_conf = conf_raw if (conf_raw and conf_raw > 0) else None
                pc = r.get("prediction_candle") if isinstance(r.get("prediction_candle"), dict) else None
                pc_close = pc.get("close") if pc and isinstance(pc.get("close"), (int, float)) else None
                if pc_close is not None:
                    strategy = f"entry≈{pc_close}"
                else:
                    strategy = r.get("strength") if isinstance(r.get("strength"), str) else None
                strength = r.get("strength") if isinstance(r.get("strength"), str) else None
                out.append(_make_signal({
                    "source": "app3",
                    "source_name": src["name"],
                    "pair": pair,
                    "direction": direction,
                    "confidence": live_conf,
                    "strength": strength,
                    "timestamp": t if t > 0 else candle_time,
                    "candle_time": candle_time,
                    "raw_candle_time": raw_candle_time,
                    "outcome": None,  # live signal, not yet resolved
                    "strategy": strategy,
                    "reasons": None,
                }, now, freshness_window_sec))
    except Exception:
        pass  # fall through to the health decision below

    error: Optional[str] = None
    if not hist_ok and not live_ok:
        health = "down"
        error = "fetch_failed"
    elif not live_ok:
        health = "disconnected"
        error = "live_fetch_failed"

    return NormalizeResult(
        signals=out,
        health=health,
        raw_count=raw_count,
        skipped=skipped,
        error=error,
    )


# ---------------------------------------------------------------------------
# Consensus
# ---------------------------------------------------------------------------


def _classify_candle(
    pair: str,
    candle_time: int,
    category: str,
    apps_map: Dict[AppId, SourceSignal],
) -> CandleConsensus:
    """Classify one candle's per-app signals.

    Only signals that are valid FOR THAT CANDLE vote. Apps are reported in
    three buckets so the dashboard can tell "app never sent anything" apart
    from "app sent something too late to count".
    """
    sigs: List[SourceSignal] = []
    missing: List[AppId] = []
    invalid: List[AppId] = []

    for app_id in ("app1", "app2", "app3"):
        s = apps_map.get(app_id)
        if s is None:
            missing.append(app_id)
            continue
        if not s.valid_for_candle:
            invalid.append(app_id)
            continue
        sigs.append(s)

    call_count = sum(1 for s in sigs if s.direction == "CALL")
    put_count = sum(1 for s in sigs if s.direction == "PUT")
    neutral_count = sum(1 for s in sigs if s.direction == "NEUTRAL")
    vote_count = call_count + put_count

    agreeing: List[AppId] = []
    disagreeing: List[AppId] = []
    level: ConsensusLevel
    direction: Optional[Direction] = None

    if vote_count == 0:
        level = "none"
    elif vote_count == 1:
        level = "1-only"
        only = next(s for s in sigs if s.direction in ("CALL", "PUT"))
        direction = only.direction
        agreeing.append(only.source)
    elif call_count == vote_count or put_count == vote_count:
        direction = "CALL" if call_count == vote_count else "PUT"
        level = "3-agree" if vote_count >= 3 else "2-agree"
        for s in sigs:
            if s.direction == direction:
                agreeing.append(s.source)
    else:
        level = "conflict"
        direction = "CALL" if call_count > put_count else "PUT" if put_count > call_count else None
        for s in sigs:
            if s.direction == "NEUTRAL":
                continue
            if direction and s.direction == direction:
                agreeing.append(s.source)
            else:
                disagreeing.append(s.source)

    sigs.sort(key=lambda s: s.source)

    return CandleConsensus(
        pair=pair,
        display_pair=display_pair_from_asset(pair),
        category=category,
        candle_time=candle_time,
        signals=sigs,
        fresh_count=len(sigs),
        call_count=call_count,
        put_count=put_count,
        neutral_count=neutral_count,
        consensus=Consensus(
            level=level,
            direction=direction,
            agreeing_apps=agreeing,
            disagreeing_apps=disagreeing,
            missing_apps=missing,
            invalid_apps=invalid,
        ),
    )


def _pick_latest_candle(candles: List[CandleConsensus], now: int) -> Optional[CandleConsensus]:
    """Pick the candle the dashboard should show as 'now'.

    ``candles`` is sorted newest first. We take the newest candle that isn't
    further ahead than one candle from the current minute: apps legitimately
    publish a signal for the NEXT candle, but anything beyond that is a bad
    timestamp, and letting such a bucket win used to blank out the whole row.
    """
    if not candles:
        return None
    max_candle = candle_floor(now) + CANDLE_SEC
    for c in candles:
        if c.candle_time <= max_candle:
            return c
    return candles[-1]


# ---------------------------------------------------------------------------
# Aggregator entrypoint
# ---------------------------------------------------------------------------


async def aggregate_signals(freshness_window_sec: int = 600) -> AggregatedResponse:
    now = int(time.time())
    timestamp_ms = int(time.time() * 1000)

    # Fan out all 3 signals-fetchers AND all 3 health-fetchers in parallel.
    results_fetch = await asyncio.gather(
        fetch_app1(freshness_window_sec, now),
        fetch_app2(freshness_window_sec, now),
        fetch_app3(freshness_window_sec, now),
        return_exceptions=True,
    )
    results_health = await asyncio.gather(
        HEALTH_FETCHERS["app1"](),
        HEALTH_FETCHERS["app2"](),
        HEALTH_FETCHERS["app3"](),
        return_exceptions=True,
    )

    # Log per-app fetch results at INFO level — this is the #1 way to debug
    # "data is not coming" complaints. Without it the user only sees
    # health=ok in the snapshot, with no clue WHY signals=0.
    for app_id, r in zip(("app1", "app2", "app3"), results_fetch):
        if isinstance(r, Exception):
            logger.error("[aggregate] %s fetch raised: %s", app_id, r)
        else:
            fresh = sum(1 for s in r.signals if s.fresh)
            logger.info(
                "[aggregate] %s: health=%s raw=%d norm=%d fresh=%d detail=%s",
                app_id, r.health, r.raw_count, len(r.signals), fresh, r.detail or r.error or "-",
            )

    r1, r2, r3 = [
        r if isinstance(r, NormalizeResult)
        else NormalizeResult(health="down", error=str(r), detail=f"fetch raised: {r}")
        for r in results_fetch
    ]
    h1, h2, h3 = results_health

    raw_results: Dict[AppId, NormalizeResult] = {
        "app1": r1,
        "app2": r2,
        "app3": r3,
    }
    # Merge health data — health endpoint is authoritative when present.
    for app_id, hr in zip(("app1", "app2", "app3"), (h1, h2, h3)):
        hr_dict = hr if isinstance(hr, dict) else None
        merged = _merge_health(raw_results[app_id], hr_dict)
        # Apply every key the merge returned — they're all now guaranteed to
        # be present (see _merge_health).
        raw_results[app_id].health = merged.get("health", raw_results[app_id].health)
        if merged.get("detail") is not None:
            raw_results[app_id].detail = merged["detail"]
        raw_results[app_id].live = merged.get("live")
        raw_results[app_id].token_expired = merged.get("token_expired")
        if merged.get("uptime_sec") is not None:
            raw_results[app_id].uptime_sec = merged["uptime_sec"]
        if merged.get("active_streams") is not None:
            raw_results[app_id].active_streams = merged["active_streams"]

    results = raw_results

    # Build AppStatus list
    apps: List[AppStatus] = []
    for src in SOURCES:
        r = results[src["id"]]
        online = r.health not in ("down", "unknown")
        apps.append(AppStatus(
            id=src["id"],
            name=src["name"],
            url=src["base_url"],
            online=online,
            last_checked=timestamp_ms,
            signal_count=len(r.signals),
            fresh_signal_count=sum(1 for s in r.signals if s.fresh),
            health=r.health,
            detail=r.detail,
            live=r.live,
            token_expired=r.token_expired,
            uptime_sec=r.uptime_sec,
            active_streams=r.active_streams,
            latency_ms=r.latency_ms,
            raw_count=r.raw_count,
            skipped=r.skipped,
            error=r.error,
        ))

    # ---- Build candle-aligned consensus ----
    pair_map: Dict[str, Tuple[bool, Dict[int, Dict[AppId, SourceSignal]]]] = {}

    for app_id in ("app1", "app2", "app3"):
        for sig in results[app_id].signals:
            entry = pair_map.get(sig.pair)
            if entry is None:
                entry = (classify_pair(sig.pair) == "otc", {})
                pair_map[sig.pair] = entry
            otc, candles = entry
            candle = candles.get(sig.candle_time)
            if candle is None:
                candle = {}
                candles[sig.candle_time] = candle
            cur = candle.get(app_id)
            if (
                cur is None
                or (sig.valid_for_candle and not cur.valid_for_candle)
                or (sig.valid_for_candle == cur.valid_for_candle and sig.timestamp > cur.timestamp)
            ):
                candle[app_id] = sig

    pairs: List[PairConsensus] = []
    for pair, (otc, candles) in pair_map.items():
        category = "otc" if otc else "real"
        candle_entries: List[CandleConsensus] = []
        for candle_time, apps_map in candles.items():
            candle_entries.append(_classify_candle(pair, candle_time, category, apps_map))

        candle_entries.sort(key=lambda c: c.candle_time, reverse=True)
        latest_candle = _pick_latest_candle(candle_entries, now)

        none_consensus = Consensus(
            level="none",
            direction=None,
            missing_apps=["app1", "app2", "app3"],
        )

        pairs.append(PairConsensus(
            pair=pair,
            display_pair=display_pair_from_asset(pair),
            category=category,
            signals=latest_candle.signals if latest_candle else [],
            candles=candle_entries,
            latest_candle=latest_candle,
            fresh_count=latest_candle.fresh_count if latest_candle else 0,
            call_count=latest_candle.call_count if latest_candle else 0,
            put_count=latest_candle.put_count if latest_candle else 0,
            neutral_count=latest_candle.neutral_count if latest_candle else 0,
            consensus=latest_candle.consensus if latest_candle else none_consensus,
        ))

    # Sort: 3-agree > 2-agree > conflict > 1-only > none; ties break by
    # category (otc first) then displayPair.
    level_order = {"3-agree": 0, "2-agree": 1, "conflict": 2, "1-only": 3, "none": 4}

    def sort_key(p: PairConsensus) -> Tuple[int, int, str]:
        return (level_order.get(p.consensus.level, 99), 0 if p.category == "otc" else 1, p.display_pair)

    pairs.sort(key=sort_key)

    summary = {
        "totalPairs": len(pairs),
        "threeBotAgree": [p for p in pairs if p.consensus.level == "3-agree"],
        "twoBotAgree": [p for p in pairs if p.consensus.level == "2-agree"],
        "conflicts": [p for p in pairs if p.consensus.level == "conflict"],
        "singleOnly": [p for p in pairs if p.consensus.level == "1-only"],
        "pairsByDirection": {
            "CALL": sum(1 for p in pairs if p.consensus.direction == "CALL"),
            "PUT": sum(1 for p in pairs if p.consensus.direction == "PUT"),
            "NEUTRAL": sum(1 for p in pairs if p.consensus.direction == "NEUTRAL"),
            "NONE": sum(1 for p in pairs if p.consensus.direction is None),
        },
    }

    return AggregatedResponse(
        timestamp=timestamp_ms,
        freshness_window_sec=freshness_window_sec,
        apps=apps,
        pairs=pairs,
        summary=summary,
    )


async def aggregate_with_raw(freshness_window_sec: int = 1800):
    """Aggregation plus the per-app raw signal lists, for /api/diag. Kept
    separate so the hot path doesn't ship the raw arrays to every dashboard
    poll."""
    now = int(time.time())
    r1, r2, r3 = await asyncio.gather(
        fetch_app1(freshness_window_sec, now),
        fetch_app2(freshness_window_sec, now),
        fetch_app3(freshness_window_sec, now),
    )
    return {"now_sec": now, "per_app": {"app1": r1, "app2": r2, "app3": r3}}
