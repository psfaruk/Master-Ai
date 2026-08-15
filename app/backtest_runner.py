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
"""

from __future__ import annotations

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
class PairStat:
    pair: str
    display_pair: str
    category: str  # "otc" | "real"
    levels: Dict[str, LevelStat]
    history: List[ClassifiedCluster]


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
    """Returns the classified cluster dict (sans ``pair``)."""
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
    gradable: List[NormalizedSignal] = [] if level == "conflict" else [a for a in signal_list if a.direction == direction]

    def is_neutral(rs: Optional[str]) -> bool:
        return rs is not None and rs.lower() in ("draw", "void")

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


def _display_pair_local(canonical: str) -> str:
    return display_pair_from_asset(canonical)


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
        for c in clusters:
            _add_cluster_to_level(pl[c.level], c.__dict__)

        per_pair.append(PairStat(
            pair=pair,
            display_pair=_display_pair_local(pair),
            category="otc" if pair.endswith("_otc") else "real",
            levels=pl,
            history=clusters,
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
        return asdict(s)

    def source_to_dict(s: SourceStat) -> dict:
        return asdict(s)

    def cluster_to_dict(c: ClassifiedCluster) -> dict:
        return asdict(c)

    def pair_to_dict(p: PairStat) -> dict:
        return {
            "pair": p.pair,
            "displayPair": p.display_pair,
            "category": p.category,
            "levels": {k: asdict(v) for k, v in p.levels.items()},
            "history": [cluster_to_dict(c) for c in p.history],
        }

    return {
        "timestamp": int(time.time() * 1000),
        "totalSignals": len(all_signals),
        "totalClusters": len(all_clusters),
        "levels": {k: level_to_dict(v) for k, v in levels.items()},
        "sources": {k: source_to_dict(v) for k, v in sources.items()},
        "perPair": [pair_to_dict(p) for p in per_pair],
        "sampleThreeAgree": [cluster_to_dict(c) for c in sample_three_agree],
        "sampleTwoAgree": [cluster_to_dict(c) for c in sample_two_agree],
        "verdict": verdict,
    }
