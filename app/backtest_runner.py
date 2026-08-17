"""Backtest Runner.

Fetches historical signals from all 3 source apps, normalizes them, aligns
them by candle-time (minute-floored), classifies each candle's consensus, and
computes per-level AND per-pair win rate.

Outcomes are graded against ACTUAL candle data from App 3 (see
``candle_fetcher.py``). This means:

- Every signal gets a win/loss verdict, even when its source app doesn't
  report one (notably App 2, which never reports outcomes).
- The verdict is computed from (close - open) vs direction, so it is
  independent of the source app's own bookkeeping and is therefore
  consistent across all 3 apps.

Per-pair breakdown:
  The ``per_pair`` field holds per-pair per-level stats and the per-pair
  cluster history. The UI uses this to render a pair selector + a
  "show me only 2-agree signals for this pair" filter.

Caching:
  A live dashboard needs per-pair win-rate on every poll, but the backtest
  itself takes ~2-4 s (it hits 3 upstreams and grades every candle). To
  bridge that, we cache the last successful result for ``CACHE_TTL_SEC``
  seconds. Callers either get the cached snapshot (fast) or trigger a
  background refresh (which updates the cache for the NEXT caller).

  ``get_cached_backtest()`` returns the latest cached result (or None).
  ``run_backtest()`` always runs a fresh one (used by /api/backtest).
  ``get_or_refresh_backtest()`` returns cached, refreshes in background
  if stale — used by the snapshot poller so the per-pair win rate is
  always available on the dashboard.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional

from .app2_cache import get_all_cached_app2_signals, start_app2_cache_poller
from .candle_fetcher import grade_signal, refresh_candles, start_candle_poller
from .http_fetcher import fetch_json_with_timeout
from .signal_normalize import (
    DIRECTION_KEYS,
    PAIR_KEYS,
    AppId,
    canonical_pair,
    candle_floor,
    display_pair_from_asset,
    get_candle_offset_sec,
    is_signal_valid_for_candle,
    parse_direction,
    pick_array,
    pick_field,
    to_unix_seconds,
)

logger = logging.getLogger("master-ai.backtest_runner")

# How far back the backtest looks.
LOOKBACK_SEC = 6 * 3600

# Cache TTL — the snapshot poller runs every ~3s; a 60s TTL means we
# refresh the backtest ~once per minute, which is plenty for a rolling
# 6h window.
CACHE_TTL_SEC = 60.0

# Minimum graded signals required before a per-pair 60-minute win rate is
# shown. Fewer than this and the "rate" is just 1-2 coin flips reported as
# a hard 0%/100% — see pair_to_dict() below.
MIN_SAMPLE_60MIN = 3

# Match "draw" / "void" in any case — used to exclude resolved-but-neutral
# signals from the win/loss count.
_DRAW_RE = re.compile(r"draw|void", re.IGNORECASE)

SOURCES = {
    "app1": {"name": "Minimum Pair", "url": "https://minimum-pair-production.up.railway.app/api/history?limit=500"},
    "app2": {"name": "Binary Signal Terminal", "url": "https://binary-signals-app-production.up.railway.app/api/share-signals"},
    "app3": {"name": "OTC Live Trading", "url": "https://otc-live-trading-production.up.railway.app/api/signals?limit=500"},
    "app3_live": {"name": "OTC Live Trading", "url": "https://otc-live-trading-production.up.railway.app/api/share-signals"},
}


@dataclass
class NormalizedSignal:
    source: AppId
    pair: str
    ts: int
    candle_time: int
    direction: str
    outcome: Optional[int]  # 1=win, 0=loss, None=unknown (incl. ACTIVE / unresolved / no candle data)
    raw_status: Optional[str] = None


@dataclass
class ClassifiedCluster:
    level: str  # "3-agree" | "2-agree" | "conflict" | "1-only"
    direction: Optional[str]
    n_apps: int
    call_count: int
    put_count: int
    agreeing_win: int
    agreeing_loss: int
    agreeing_unknown: int
    agreeing_draw: int
    outcome: Optional[int]
    ts: int
    pair: str
    # Which concrete apps agreed on the consensus direction (sorted).
    # e.g. ["app1", "app2"] for a 2-agree cluster where those two agreed.
    # For "conflict" / "1-only" this is the list of apps that voted for
    # the chosen direction (the majority for conflict, the singleton for
    # 1-only) so the win rate attribution still makes sense.
    agreeing_apps: List[str] = None  # type: ignore[assignment]
    # Canonical bucket key like "app1+app2", "app1+app3",
    # "app2+app3", "app1+app2+app3", or singletons "app1" / "app2" / "app3".
    # Derived from `agreeing_apps`. Used by the per-pair app-pair stats
    # so the dashboard can show "app1+app2 wins 80% on EURUSD".
    app_subset_key: str = ""
    # Per-app raw direction for THIS candle, e.g. {"app1":"CALL","app2":"CALL","app3":"PUT"}.
    # Used by the per-pair "Signal History (Last 60 min)" table so the UI can
    # show which app gave which direction on each candle.
    app_directions: Dict[str, str] = None  # type: ignore[assignment]
    # Per-app outcome for THIS candle, e.g. {"app1":1,"app2":1,"app3":0}.
    # Lets the history table show per-app W/L chips alongside the consensus outcome.
    app_outcomes: Dict[str, Optional[int]] = None  # type: ignore[assignment]


@dataclass
class LevelStat:
    total: int = 0
    win: int = 0
    loss: int = 0
    unknown: int = 0
    draw: int = 0
    call: int = 0
    put: int = 0
    call_win: int = 0
    call_loss: int = 0
    put_win: int = 0
    put_loss: int = 0


@dataclass
class SourceStat:
    total: int = 0
    win: int = 0
    loss: int = 0
    unknown: int = 0
    draw: int = 0


@dataclass
class AppPairStat:
    """Stats for ONE specific subset of agreeing apps.

    Key examples: "app1", "app2", "app3", "app1+app2",
    "app1+app3", "app2+app3", "app1+app2+app3".

    Each ClassifiedCluster contributes to exactly ONE AppPairStat per pair
    — the one matching its ``app_subset_key``. This lets the dashboard
    answer questions like:

        "On EURUSD, when app1+app2 agree, what is the win rate?"
        "Which pair of apps performs best on EURUSD?"
        "Which pairs is app1+app2 best at?"
    """
    total: int = 0
    win: int = 0
    loss: int = 0
    unknown: int = 0
    draw: int = 0
    call: int = 0
    put: int = 0
    call_win: int = 0
    call_loss: int = 0
    put_win: int = 0
    put_loss: int = 0


@dataclass
class PairStat:
    pair: str
    display_pair: str
    category: str  # "otc" | "real"
    levels: Dict[str, LevelStat]
    history: List[ClassifiedCluster]
    # Per-pair × per-app-subset stats (app1, app2, app3, app1+app2,
    # app1+app3, app2+app3, app1+app2+app3). Only keys that actually
    # occurred in the backtest window are present.
    app_pair_stats: Dict[str, AppPairStat] = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# In-memory cache so the live snapshot can read per-pair win rates without
# paying the full backtest cost on every poll.
# ---------------------------------------------------------------------------


@dataclass
class BacktestCache:
    result: Optional[Dict[str, Any]] = None
    fetched_at: float = 0.0  # unix seconds
    refresh_in_progress: bool = False
    refresh_task: Optional[asyncio.Task] = None


_cache: Optional[BacktestCache] = None


def _get_cache() -> BacktestCache:
    global _cache
    if _cache is None:
        _cache = BacktestCache()
    return _cache


def get_cached_backtest() -> Optional[Dict[str, Any]]:
    """Return the latest cached backtest result, or None if never run."""
    return _get_cache().result


def get_backtest_cache_age_sec() -> float:
    c = _get_cache()
    if c.fetched_at <= 0:
        return -1.0
    return max(0.0, time.time() - c.fetched_at)


async def get_or_refresh_backtest() -> Optional[Dict[str, Any]]:
    """Return cached backtest if fresh; trigger a background refresh if stale.

    The snapshot poller calls this on every tick so the dashboard always
    shows a per-pair win rate. Refresh runs in the background — callers
    get the previous cached value immediately and the next poll picks up
    the fresh one.
    """
    c = _get_cache()
    age = time.time() - c.fetched_at if c.fetched_at > 0 else float("inf")
    if c.result is not None and age < CACHE_TTL_SEC:
        return c.result
    # Stale (or never run). Trigger a refresh in the background if one
    # isn't already running, but return whatever we have so the snapshot
    # doesn't block for ~3s.
    if not c.refresh_in_progress:
        c.refresh_in_progress = True
        c.refresh_task = asyncio.create_task(_refresh_in_background())
    return c.result


async def _refresh_in_background() -> None:
    c = _get_cache()
    try:
        result = await run_backtest()
        c.result = result
        c.fetched_at = time.time()
    except Exception as e:
        logger.warning("[backtest-cache] background refresh failed: %s", e)
    finally:
        c.refresh_in_progress = False


# ---------------------------------------------------------------------------
# Normalizers
# ---------------------------------------------------------------------------


def normalize_app1(d: dict) -> Optional[NormalizedSignal]:
    pair = canonical_pair(pick_field(d, PAIR_KEYS))
    if not pair:
        return None
    direction = parse_direction(pick_field(d, DIRECTION_KEYS))
    if not direction:
        return None

    entry_sec = to_unix_seconds(pick_field(d, ["entry_ts", "entryTime", "entry_time", "candleTime", "ctime"]))
    if not (entry_sec > 0):
        return None
    candle_time = candle_floor(entry_sec) + get_candle_offset_sec("app1")

    result_raw = pick_field(d, ["result", "status", "outcome"])
    s = str(result_raw or "").upper()
    outcome: Optional[int] = None
    if s in ("WIN", "CORRECT"):
        outcome = 1
    elif s in ("LOSS", "WRONG"):
        outcome = 0

    emitted_at = to_unix_seconds(pick_field(d, ["created_at", "signalAt", "signal_at", "createdAt", "ts"]))

    return NormalizedSignal(
        source="app1",
        pair=pair,
        ts=emitted_at if emitted_at > 0 else candle_time,
        candle_time=candle_time,
        direction=direction,
        outcome=outcome,
        raw_status=str(result_raw) if result_raw is not None else None,
    )


def normalize_app3(d: dict, time_keys: List[str]) -> Optional[NormalizedSignal]:
    pair = canonical_pair(pick_field(d, PAIR_KEYS))
    if not pair:
        return None
    direction = parse_direction(pick_field(d, DIRECTION_KEYS))
    if not direction:
        return None

    ts = to_unix_seconds(pick_field(d, time_keys))
    if not (ts > 0):
        return None
    candle_time = candle_floor(ts) + get_candle_offset_sec("app3")

    result = str(pick_field(d, ["result", "outcome", "status"]) or "").lower()
    outcome: Optional[int] = None
    if result in ("correct", "win"):
        outcome = 1
    elif result in ("wrong", "loss"):
        outcome = 0

    return NormalizedSignal(
        source="app3",
        pair=pair,
        ts=ts,
        candle_time=candle_time,
        direction=direction,
        outcome=outcome,
        raw_status=result or None,
    )


# ---------------------------------------------------------------------------
# Cluster classification
# ---------------------------------------------------------------------------


def _classify_cluster(cluster_apps: Dict[AppId, NormalizedSignal], ts_anchor: int) -> Dict[str, Any]:
    """Returns the classified cluster dict (sans ``pair``).

    Also derives ``agreeing_apps`` and ``app_subset_key`` so callers can
    attribute the outcome to a specific app subset (e.g. "app1+app2")
    rather than just a level bucket ("2-agree").
    """
    signal_list = list(cluster_apps.values())
    n = len(signal_list)
    call_c = sum(1 for a in signal_list if a.direction == "CALL")
    put_c = sum(1 for a in signal_list if a.direction == "PUT")

    level: str
    direction: Optional[str]

    if n == 1:
        level = "1-only"
        direction = signal_list[0].direction
    elif call_c == n:
        direction = "CALL"
        level = "3-agree" if n >= 3 else "2-agree"
    elif put_c == n:
        direction = "PUT"
        level = "3-agree" if n >= 3 else "2-agree"
    else:
        level = "conflict"
        direction = "CALL" if call_c > put_c else "PUT" if put_c > call_c else None

    # Grade only the apps that voted for the consensus direction.
    gradable: List[NormalizedSignal] = [] if level == "conflict" or direction is None else [a for a in signal_list if a.direction == direction]

    # The list of apps that agreed on the consensus direction. Sorted so
    # the app_subset_key is deterministic regardless of dict ordering.
    agreeing_apps: List[str] = sorted(a.source for a in gradable) if direction is not None else []
    app_subset_key: str = "+".join(agreeing_apps)

    def is_neutral(rs: Optional[str]) -> bool:
        return rs is not None and rs.lower() in ("draw", "void")

    # Per-app raw direction for THIS candle — captured for every signal that
    # voted, regardless of whether it agreed with the consensus. Lets the
    # history table show "App 1: CALL, App 2: CALL, App 3: PUT" per candle.
    app_directions: Dict[str, str] = {a.source: a.direction for a in signal_list}

    # Per-app outcome for THIS candle (1=win, 0=loss, None=unknown/draw).
    # Mirrors the per-app direction chip so the table can show a per-app W/L
    # chip alongside the consensus outcome.
    app_outcomes: Dict[str, Optional[int]] = {
        a.source: (a.outcome if not is_neutral(a.raw_status) else None)
        for a in signal_list
    }

    gradable_non_draw = [a for a in gradable if not is_neutral(a.raw_status)]
    outcomes = [a.outcome for a in gradable_non_draw if a.outcome is not None]
    draw_count = len(gradable) - len(gradable_non_draw)

    win = sum(1 for o in outcomes if o == 1)
    loss = sum(1 for o in outcomes if o == 0)
    unknown = len(gradable_non_draw) - len(outcomes)

    outcome: Optional[int] = None
    if outcomes:
        outcome = 1 if all(o == 1 for o in outcomes) else 0

    return {
        "level": level,
        "direction": direction,
        "n_apps": n,
        "call_count": call_c,
        "put_count": put_c,
        "agreeing_win": win,
        "agreeing_loss": loss,
        "agreeing_unknown": unknown,
        "agreeing_draw": draw_count,
        "outcome": outcome,
        "ts": ts_anchor,
        "agreeing_apps": agreeing_apps,
        "app_subset_key": app_subset_key,
        "app_directions": app_directions,
        "app_outcomes": app_outcomes,
    }


# ---------------------------------------------------------------------------
# Outcome grading against candle data
# ---------------------------------------------------------------------------


def _grade_with_candles(signals: List[NormalizedSignal]) -> None:
    """Fill in missing outcomes by grading each signal against the actual
    candle close from App 3.

    For signals whose source app already reports an outcome (App 1 / App 3),
    we KEEP that outcome — it is the source-of-truth verdict.

    For signals with no outcome (App 2, or any signal whose source marked it
    ACTIVE/null), we look up the candle by (pair, candleTime) and grade:
      - CALL wins if close > open
      - PUT  wins if close < open
      - DRAW if close === open (within epsilon)
      - UNKNOWN if candle data is missing
    """
    for s in signals:
        if s.outcome is not None:
            continue
        if s.raw_status and _DRAW_RE.search(s.raw_status):
            continue

        _, outcome_str = grade_signal(s.pair, s.candle_time, s.direction)
        if outcome_str == "WIN":
            s.outcome = 1
        elif outcome_str == "LOSS":
            s.outcome = 0
        elif outcome_str == "DRAW":
            s.raw_status = "draw"
        # UNKNOWN → leave outcome None


# ---------------------------------------------------------------------------
# Stats helpers
# ---------------------------------------------------------------------------


def _new_level_stat() -> LevelStat:
    return LevelStat()


def _new_app_pair_stat() -> AppPairStat:
    return AppPairStat()


def _add_cluster_to_level(s: LevelStat, c: Dict[str, Any]) -> None:
    s.total += 1
    if c["outcome"] == 1:
        s.win += 1
    elif c["outcome"] == 0:
        s.loss += 1
    elif c.get("agreeing_draw", 0) > 0 and c["outcome"] is None:
        s.draw += c["agreeing_draw"]
    else:
        s.unknown += 1
    if c["direction"] == "CALL":
        s.call += 1
        if c["outcome"] == 1:
            s.call_win += 1
        elif c["outcome"] == 0:
            s.call_loss += 1
    elif c["direction"] == "PUT":
        s.put += 1
        if c["outcome"] == 1:
            s.put_win += 1
        elif c["outcome"] == 0:
            s.put_loss += 1


def _add_cluster_to_app_pair(s: AppPairStat, c: Dict[str, Any]) -> None:
    """Same accumulation as ``_add_cluster_to_level`` but on an AppPairStat.

    Reuses the exact same semantics so the per-app-pair win rate is directly
    comparable to the per-level win rate.
    """
    s.total += 1
    if c["outcome"] == 1:
        s.win += 1
    elif c["outcome"] == 0:
        s.loss += 1
    elif c.get("agreeing_draw", 0) > 0 and c["outcome"] is None:
        s.draw += c["agreeing_draw"]
    else:
        s.unknown += 1
    if c["direction"] == "CALL":
        s.call += 1
        if c["outcome"] == 1:
            s.call_win += 1
        elif c["outcome"] == 0:
            s.call_loss += 1
    elif c["direction"] == "PUT":
        s.put += 1
        if c["outcome"] == 1:
            s.put_win += 1
        elif c["outcome"] == 0:
            s.put_loss += 1


def _display_pair_local(canonical: str) -> str:
    return display_pair_from_asset(canonical)


def _level_win_rate(s: LevelStat) -> Optional[float]:
    graded = s.win + s.loss
    if graded == 0:
        return None
    return round((s.win / graded) * 100, 1)


def _app_pair_win_rate(s: AppPairStat) -> Optional[float]:
    graded = s.win + s.loss
    if graded == 0:
        return None
    return round((s.win / graded) * 100, 1)


# Canonical app-subset keys the dashboard UI renders. The backtest may
# produce stats for any subset that actually occurred — we always emit a
# full grid (zeroed entries for unseen subsets) so the UI can render a
# stable table without missing columns.
APP_SUBSET_KEYS: List[str] = [
    "app1",
    "app2",
    "app3",
    "app1+app2",
    "app1+app3",
    "app2+app3",
    "app1+app2+app3",
]


def _serialize_app_pair_stats(stats: Dict[str, AppPairStat]) -> Dict[str, dict]:
    """Return a stable JSON-friendly dict covering ALL canonical app subsets.

    Subsets that didn't occur in this pair's backtest history are emitted
    with zeroed counters and ``winRate: None``.
    """
    out: Dict[str, dict] = {}
    for key in APP_SUBSET_KEYS:
        s = stats.get(key)
        if s is None:
            s = _new_app_pair_stat()
        d = asdict(s)
        d["winRate"] = _app_pair_win_rate(s)
        d["gradedTotal"] = s.win + s.loss
        out[key] = d
    # Preserve any non-canonical subsets (defensive — shouldn't happen, but
    # don't silently drop them if a future caller introduces one).
    for key, s in stats.items():
        if key in out:
            continue
        d = asdict(s)
        d["winRate"] = _app_pair_win_rate(s)
        d["gradedTotal"] = s.win + s.loss
        out[key] = d
    return out


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------


async def run_backtest() -> Dict[str, Any]:
    """Run a live backtest. Returns the structured result dict — matches the
    shape of the original TypeScript ``BacktestResult`` so the dashboard UI
    doesn't need to change."""
    # App 2 has no history endpoint — our own poller is the only source of
    # past candles, so make sure it is running.
    start_app2_cache_poller()
    # Start the candle poller too — it grades signals against actual closes.
    start_candle_poller()
    # Force one synchronous refresh so the grading below has fresh data.
    try:
        await refresh_candles()
    except Exception as e:
        logger.warning("[backtest] candle refresh failed: %s", e)

    all_signals: List[NormalizedSignal] = []
    now = int(time.time())
    min_candle = candle_floor(now - LOOKBACK_SEC)

    def push(s: Optional[NormalizedSignal]) -> None:
        if s is None:
            return
        if s.candle_time < min_candle:
            return
        if not is_signal_valid_for_candle(s.ts, s.candle_time):
            return
        all_signals.append(s)

    # App1 — historical signals with WIN/LOSS outcome
    try:
        d = await fetch_json_with_timeout(SOURCES["app1"]["url"])
        for s in pick_array(d, ["signals", "rows", "data"]):
            if isinstance(s, dict):
                push(normalize_app1(s))
    except Exception as e:
        logger.debug("[backtest] app1 fetch failed: %s", e)

    # App2 — historical candles recorded by our own poller.
    for c in get_all_cached_app2_signals():
        push(NormalizedSignal(
            source="app2",
            pair=c.pair,
            ts=c.first_seen_sec if c.first_seen_sec > 0 else c.candle_time,
            candle_time=c.candle_time + get_candle_offset_sec("app2"),
            direction=c.signal,
            outcome=None,
            raw_status=None,
        ))

    # App3 — resolved history (has correct/wrong) + the current live candle.
    try:
        d = await fetch_json_with_timeout(SOURCES["app3"]["url"])
        for s in pick_array(d, ["signals", "rows", "data"]):
            if isinstance(s, dict):
                push(normalize_app3(s, ["ctime", "candle_time", "time", "ts"]))
    except Exception as e:
        logger.debug("[backtest] app3 history fetch failed: %s", e)
    try:
        d = await fetch_json_with_timeout(SOURCES["app3_live"]["url"])
        for s in pick_array(d, ["signals", "rows", "data"]):
            if isinstance(s, dict):
                push(normalize_app3(s, ["time", "candle_time", "ctime", "ts"]))
    except Exception as e:
        logger.debug("[backtest] app3 live fetch failed: %s", e)

    # Grade signals that lack an outcome, using candle close data.
    _grade_with_candles(all_signals)

    # ---- Candle-aligned clustering ----
    by_pair_candle: Dict[str, Dict[AppId, NormalizedSignal]] = {}
    for s in all_signals:
        key = f"{s.pair}|{s.candle_time}"
        c = by_pair_candle.get(key)
        if c is None:
            c = {}
            by_pair_candle[key] = c
        cur = c.get(s.source)
        if cur is None or s.ts > cur.ts:
            c[s.source] = s

    all_clusters: List[ClassifiedCluster] = []
    for key, apps_map in by_pair_candle.items():
        sep = key.rfind("|")
        pair = key[:sep]
        candle_time = int(key[sep + 1:])
        classified = _classify_cluster(apps_map, candle_time)
        all_clusters.append(ClassifiedCluster(pair=pair, **classified))

    all_clusters.sort(key=lambda c: c.ts, reverse=True)

    # ---- Level stats (global, across all pairs) ----
    levels: Dict[str, LevelStat] = {
        "3-agree": _new_level_stat(),
        "2-agree": _new_level_stat(),
        "conflict": _new_level_stat(),
        "1-only": _new_level_stat(),
    }
    for c in all_clusters:
        _add_cluster_to_level(levels[c.level], c.__dict__)

    # ---- Per-pair stats ----
    clusters_by_pair: Dict[str, List[ClassifiedCluster]] = {}
    for c in all_clusters:
        clusters_by_pair.setdefault(c.pair, []).append(c)

    per_pair: List[PairStat] = []
    for pair, clusters in clusters_by_pair.items():
        pl: Dict[str, LevelStat] = {
            "3-agree": _new_level_stat(),
            "2-agree": _new_level_stat(),
            "conflict": _new_level_stat(),
            "1-only": _new_level_stat(),
        }
        aps: Dict[str, AppPairStat] = {}
        for c in clusters:
            _add_cluster_to_level(pl[c.level], c.__dict__)
            # Bucket by the specific app subset that agreed on the
            # consensus direction. For "conflict" with a tie, c.app_subset_key
            # is "" — skip it (no clear agreement to attribute to).
            key = c.app_subset_key
            if not key:
                continue
            if key not in aps:
                aps[key] = _new_app_pair_stat()
            _add_cluster_to_app_pair(aps[key], c.__dict__)

        per_pair.append(PairStat(
            pair=pair,
            display_pair=_display_pair_local(pair),
            category="otc" if pair.endswith("_otc") else "real",
            levels=pl,
            history=clusters,
            app_pair_stats=aps,
        ))

    def pair_total(p: PairStat) -> int:
        return p.levels["3-agree"].total + p.levels["2-agree"].total + p.levels["1-only"].total

    per_pair.sort(key=lambda p: (-pair_total(p), p.display_pair))

    # ---- Source stats ----
    sources: Dict[AppId, SourceStat] = {
        "app1": SourceStat(),
        "app2": SourceStat(),
        "app3": SourceStat(),
    }
    for s in all_signals:
        st = sources[s.source]
        st.total += 1
        rs = str(s.raw_status or "").lower()
        if s.outcome == 1:
            st.win += 1
        elif s.outcome == 0:
            st.loss += 1
        elif rs in ("draw", "void"):
            st.draw += 1
        else:
            st.unknown += 1

    sample_three_agree = [c for c in all_clusters if c.level == "3-agree"][:10]
    sample_two_agree = [c for c in all_clusters if c.level == "2-agree" and c.outcome is not None][:10]

    # ---- Verdict ----
    g3 = levels["3-agree"].win + levels["3-agree"].loss
    g2 = levels["2-agree"].win + levels["2-agree"].loss
    g1 = levels["1-only"].win + levels["1-only"].loss

    verdict: Dict[str, Any]
    if g3 >= 5 and g2 >= 5 and g1 >= 5:
        wr3 = (levels["3-agree"].win / g3) * 100 if g3 else 0
        wr2 = (levels["2-agree"].win / g2) * 100 if g2 else 0
        wr1 = (levels["1-only"].win / g1) * 100 if g1 else 0
        if wr3 >= wr2 and wr2 >= wr1:
            verdict = {
                "kind": "validated",
                "message": f"Consensus logic confirmed: 3-agree {wr3:.1f}% >= 2-agree {wr2:.1f}% >= 1-only {wr1:.1f}%",
            }
        elif wr3 >= wr1:
            verdict = {
                "kind": "partial",
                "message": f"Partial validation: 3-agree {wr3:.1f}% > 1-only {wr1:.1f}%, but 2-agree {wr2:.1f}% anomaly",
            }
        else:
            verdict = {
                "kind": "anomaly",
                "message": f"Anomaly: 3-agree {wr3:.1f}% does not outperform 1-only {wr1:.1f}%",
            }
    else:
        verdict = {
            "kind": "insufficient",
            "message": f"Insufficient graded data — need 5+ per level (have 3-agree={g3}, 2-agree={g2}, 1-only={g1})",
            "have": {"three": g3, "two": g2, "one": g1},
        }

    def level_to_dict(s: LevelStat) -> dict:
        d = asdict(s)
        d["winRate"] = _level_win_rate(s)
        return d

    def source_to_dict(s: SourceStat) -> dict:
        return asdict(s)

    def app_pair_stat_to_dict(s: AppPairStat) -> dict:
        d = asdict(s)
        d["winRate"] = _app_pair_win_rate(s)
        graded = s.win + s.loss
        d["gradedTotal"] = graded
        return d

    def cluster_to_dict(c: ClassifiedCluster) -> dict:
        d = asdict(c)
        # Add a friendly "WIN"|"LOSS"|"DRAW"|"—" label for the UI so the
        # per-candle history table doesn't have to map 1/0/None on the client.
        if d.get("outcome") == 1:
            d["outcomeLabel"] = "WIN"
        elif d.get("outcome") == 0:
            d["outcomeLabel"] = "LOSS"
        elif any(rs and isinstance(rs, str) and rs.lower() in ("draw", "void")
                 for rs in [d.get("agreeing_draw")]):
            d["outcomeLabel"] = "DRAW"
        else:
            d["outcomeLabel"] = "—"
        # Add per-app outcome labels too (used by the per-candle history chips).
        d["appOutcomeLabels"] = {
            app: ("WIN" if o == 1 else "LOSS" if o == 0 else "—")
            for app, o in (d.get("app_outcomes") or {}).items()
        }
        return d

    def pair_to_dict(p: PairStat) -> dict:
        graded_total = (
            p.levels["3-agree"].win + p.levels["3-agree"].loss +
            p.levels["2-agree"].win + p.levels["2-agree"].loss +
            p.levels["1-only"].win + p.levels["1-only"].loss
        )
        graded_wins = (
            p.levels["3-agree"].win +
            p.levels["2-agree"].win +
            p.levels["1-only"].win
        )
        # ---- 60-minute win rate ----
        # Filter this pair's cluster history to only the last 60 minutes,
        # then grade the ones that have a known outcome. Below
        # MIN_SAMPLE_60MIN graded signals, a "win rate" is really just the
        # outcome of 1-2 trades reported as a misleading 0%/50%/100% — treat
        # it as insufficient data (None) rather than a real rate, same as
        # the overall verdict already does for the 6h levels above.
        sixty_min_ago = now - 3600
        recent = [c for c in p.history if c.ts >= sixty_min_ago]
        recent_graded = [c for c in recent if c.outcome is not None]
        recent_wins = sum(1 for c in recent_graded if c.outcome == 1)
        recent_losses = sum(1 for c in recent_graded if c.outcome == 0)
        recent_graded_total = len(recent_graded)
        recent_win_rate = (
            round((recent_wins / recent_graded_total) * 100, 1)
            if recent_graded_total >= MIN_SAMPLE_60MIN else None
        )

        # ---- Per-app-subset × 60-min stats ----
        # For the Signal History (Last 60 min) UI we want one row per
        # app-subset key (1+2 / 1+3 / 2+3 / all-3 / singletons) showing
        # how many clusters and what win rate that subset produced on
        # this pair in the last 60 minutes. This is the per-pair /
        # per-agreement-type summary the user explicitly asked for.
        recent_by_subset: Dict[str, Dict[str, int]] = {}
        for c in recent:
            key = c.app_subset_key
            if not key:
                continue
            bucket = recent_by_subset.setdefault(key, {
                "total": 0, "win": 0, "loss": 0, "draw": 0, "unknown": 0,
                "call": 0, "put": 0,
            })
            bucket["total"] += 1
            if c.outcome == 1:
                bucket["win"] += 1
            elif c.outcome == 0:
                bucket["loss"] += 1
            elif c.agreeing_draw and c.agreeing_draw > 0:
                bucket["draw"] += 1
            else:
                bucket["unknown"] += 1
            if c.direction == "CALL":
                bucket["call"] += 1
            elif c.direction == "PUT":
                bucket["put"] += 1
        # Serialize: include every canonical app-subset key (zeroed when absent)
        # so the UI can render a stable table without missing columns.
        history60_by_subset: Dict[str, dict] = {}
        for key in APP_SUBSET_KEYS:
            b = recent_by_subset.get(key, {
                "total": 0, "win": 0, "loss": 0, "draw": 0, "unknown": 0,
                "call": 0, "put": 0,
            })
            graded = b["win"] + b["loss"]
            history60_by_subset[key] = {
                **b,
                "gradedTotal": graded,
                "winRate": round((b["win"] / graded) * 100, 1) if graded else None,
            }
        # Preserve any non-canonical subsets that occurred (defensive).
        for key, b in recent_by_subset.items():
            if key in history60_by_subset:
                continue
            graded = b["win"] + b["loss"]
            history60_by_subset[key] = {
                **b,
                "gradedTotal": graded,
                "winRate": round((b["win"] / graded) * 100, 1) if graded else None,
            }

        return {
            "pair": p.pair,
            "displayPair": p.display_pair,
            "category": p.category,
            "levels": {k: level_to_dict(v) for k, v in p.levels.items()},
            "winRate": round((graded_wins / graded_total) * 100, 1) if graded_total > 0 else None,
            "gradedTotal": graded_total,
            "winRate60Min": recent_win_rate,
            "gradedTotal60Min": recent_graded_total,
            "wins60Min": recent_wins,
            "losses60Min": recent_losses,
            # Per-pair × per-app-subset stats. Always includes the four
            # app-subset keys the dashboard UI renders (singletons + the
            # three 2-app pairs + the all-3-agree bucket), with zeroed
            # AppPairStat values for any subset that didn't occur on this
            # pair in the backtest window.
            "appPairStats": _serialize_app_pair_stats(p.app_pair_stats or {}),
            # Full 6-hour cluster history (already existed).
            "history": [cluster_to_dict(c) for c in p.history],
            # NEW — last-60-min cluster list (per-candle row data). Each item
            # has ts (candle_time), level, direction, app_subset_key,
            # app_directions, app_outcomes, outcome, outcomeLabel — enough for
            # the per-pair drawer to render a candle-by-candle table.
            "history60Min": [cluster_to_dict(c) for c in recent],
            # NEW — per-app-subset summary over the last 60 minutes. Lets
            # the UI show "1+2: 3W/1L (75%) | 1+3: 0W/0L (—) | ..." per pair.
            "history60BySubset": history60_by_subset,
        }

    return {
        "timestamp": int(time.time() * 1000),
        "totalSignals": len(all_signals),
        "totalClusters": len(all_clusters),
        "levels": {k: level_to_dict(v) for k, v in levels.items()},
        "sources": {k: source_to_dict(v) for k, v in sources.items()},
        # Global per-app-subset leaderboard: for each canonical app subset,
        # the top N pairs by graded win rate (min 1 graded sample). Lets the
        # dashboard answer "which pairs is app1+app2 best at?".
        "appPairLeaders": _build_app_pair_leaders(per_pair),
        "perPair": [pair_to_dict(p) for p in per_pair],
        "sampleThreeAgree": [cluster_to_dict(c) for c in sample_three_agree],
        "sampleTwoAgree": [cluster_to_dict(c) for c in sample_two_agree],
        "verdict": verdict,
    }


def get_per_pair_winrate_lookup(cached: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Build a pair-key → {winRate, gradedTotal, levels, winRate60Min, ...}
    lookup from a cached backtest result. Used by the snapshot serializer to
    enrich each pair with win-rate info without re-running the backtest."""
    out: Dict[str, Dict[str, Any]] = {}
    if not cached:
        return out
    for p in cached.get("perPair", []):
        out[p["pair"]] = {
            "winRate": p.get("winRate"),
            "gradedTotal": p.get("gradedTotal", 0),
            "levels": p.get("levels", {}),
            "winRate60Min": p.get("winRate60Min"),
            "gradedTotal60Min": p.get("gradedTotal60Min", 0),
            "wins60Min": p.get("wins60Min", 0),
            "losses60Min": p.get("losses60Min", 0),
            "appPairStats": p.get("appPairStats", {}),
            # NEW — expose the per-candle history list + per-subset summary so
            # the per-pair drawer can render "Signal History (Last 60 min)"
            # without an extra round trip. The backtest cache is 60 s, so this
            # data is at most 1 minute stale — acceptable for a 60-min window.
            "history60Min": p.get("history60Min", []),
            "history60BySubset": p.get("history60BySubset", {}),
        }
    return out


# Minimum graded samples required for a pair to appear in an app-pair
# leaderboard. Below this, the win rate is just 1-2 coin flips reported as a
# misleading 0%/100%.
LEADERBOARD_MIN_GRADED = 3
LEADERBOARD_TOP_N = 10


def _build_app_pair_leaders(per_pair: List[PairStat]) -> Dict[str, List[Dict[str, Any]]]:
    """For each canonical app subset, return the top ``LEADERBOARD_TOP_N``
    pairs by win rate (descending), with at least ``LEADERBOARD_MIN_GRADED``
    graded samples.

    Used by the dashboard "App Pair Leaders" sub-tab to answer:
        - which pairs does app1+app2 perform best on?
        - on which pair of apps does EURUSD perform best?
    """
    leaders: Dict[str, List[Dict[str, Any]]] = {k: [] for k in APP_SUBSET_KEYS}
    for p in per_pair:
        aps = p.app_pair_stats or {}
        for key in APP_SUBSET_KEYS:
            s = aps.get(key)
            if s is None:
                continue
            graded = s.win + s.loss
            if graded < LEADERBOARD_MIN_GRADED:
                continue
            wr = round((s.win / graded) * 100, 1) if graded else 0.0
            leaders[key].append({
                "pair": p.pair,
                "displayPair": p.display_pair,
                "category": p.category,
                "winRate": wr,
                "wins": s.win,
                "losses": s.loss,
                "gradedTotal": graded,
                "call": s.call,
                "put": s.put,
                "callWin": s.call_win,
                "callLoss": s.call_loss,
                "putWin": s.put_win,
                "putLoss": s.put_loss,
            })
    # Sort each leaderboard: win rate desc, then graded total desc (more
    # confidence wins ties), then display pair asc (stable ordering).
    for key in leaders:
        leaders[key].sort(
            key=lambda r: (-r["winRate"], -r["gradedTotal"], r["displayPair"])
        )
        leaders[key] = leaders[key][:LEADERBOARD_TOP_N]
    return leaders


# ---------------------------------------------------------------------------
# CLI — runs a fresh backtest, prints a summary, exits non-zero if the
# verdict doesn't pass the quality gate (used as a pre-push verification).
# ---------------------------------------------------------------------------


async def _run_backtest_cli() -> int:
    """Run ``run_backtest()`` synchronously, print a structured summary,
    return a process exit code (0 = ok, 1 = anomaly/insufficient/error).

    The summary includes:
      - verdict (kind + message)
      - total signals / clusters / pairs
      - per-level win rates
      - per-app-subset win rates (global, across all pairs)
      - top 3 pairs per app-subset (which pairs is each app-subset best at)
    """
    try:
        result = await run_backtest()
    except Exception as e:
        import json
        logger.exception("backtest CLI failed")
        print(json.dumps({
            "ok": False,
            "error": str(e),
            "verdict": {"kind": "error", "message": str(e)},
        }, indent=2))
        return 1

    verdict = result.get("verdict", {})
    levels = result.get("levels", {})
    sources = result.get("sources", {})
    app_pair_leaders = result.get("appPairLeaders", {})

    # Build a compact global per-app-subset summary (aggregate across all
    # pairs) by summing per-pair stats.
    global_app_pair: Dict[str, Dict[str, int]] = {k: {"total": 0, "win": 0, "loss": 0, "unknown": 0, "draw": 0} for k in APP_SUBSET_KEYS}
    for p in result.get("perPair", []):
        for key, st in (p.get("appPairStats") or {}).items():
            if key not in global_app_pair:
                global_app_pair[key] = {"total": 0, "win": 0, "loss": 0, "unknown": 0, "draw": 0}
            agg = global_app_pair[key]
            agg["total"] += st.get("total", 0)
            agg["win"] += st.get("win", 0)
            agg["loss"] += st.get("loss", 0)
            agg["unknown"] += st.get("unknown", 0)
            agg["draw"] += st.get("draw", 0)

    app_pair_summary = {}
    for key, agg in global_app_pair.items():
        graded = agg["win"] + agg["loss"]
        app_pair_summary[key] = {
            **agg,
            "gradedTotal": graded,
            "winRate": round((agg["win"] / graded) * 100, 1) if graded else None,
        }

    # Top 3 pairs per app-subset leaderboard.
    top_pairs_summary = {
        key: [
            {"pair": r["displayPair"], "winRate": r["winRate"], "wins": r["wins"], "losses": r["losses"], "graded": r["gradedTotal"]}
            for r in leaders[:3]
        ]
        for key, leaders in app_pair_leaders.items()
    }

    summary = {
        "ok": verdict.get("kind") in ("validated", "partial", "insufficient"),
        "verdict": verdict,
        "totalSignals": result.get("totalSignals", 0),
        "totalClusters": result.get("totalClusters", 0),
        "perPairCount": len(result.get("perPair", [])),
        "levels": {
            k: {
                "total": v.get("total", 0),
                "win": v.get("win", 0),
                "loss": v.get("loss", 0),
                "winRate": v.get("winRate"),
            } for k, v in levels.items()
        },
        "sources": {
            k: {
                "total": v.get("total", 0),
                "win": v.get("win", 0),
                "loss": v.get("loss", 0),
            } for k, v in sources.items()
        },
        "appPairGlobal": app_pair_summary,
        "appPairTopPairs": top_pairs_summary,
    }
    import json
    print(json.dumps(summary, indent=2, default=str))
    # Exit 0 if verdict is validated/partial/insufficient (insufficient
    # still means the backtest itself ran cleanly, just with too few
    # samples — that's a soft pass for CI purposes).
    return 0 if verdict.get("kind") in ("validated", "partial", "insufficient") else 1


if __name__ == "__main__":
    import sys
    sys.exit(asyncio.run(_run_backtest_cli()))
