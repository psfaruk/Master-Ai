"""FastAPI routes for the Master-Ai dashboard.

JSON endpoints (all under /api, all carry Cache-Control: no-store + CORS *):

Aggregation:
  - GET /api/aggregated          — unified snapshot + per-pair consensus (verbose)
  - GET /api/snapshot            — cached aggregated snapshot (cheap read; the
                                   dashboard polls this)

Signals:
  - GET /api/signal-feed         — flat chronological list of the freshest
                                   signals across all 3 apps, with emitted-at
                                   + candle-time + lead/lag in seconds
  - GET /api/pairs               — full per-pair breakdown incl. win rate
  - GET /api/pair/{pair}         — single-pair detail: latest candles,
                                   per-app signals, win rate, candle history

History / Backtest:
  - GET /api/candles?pair=...    — per-pair OHLC candle history
  - GET /api/backtest            — run (or read cached) consensus backtest
  - GET /api/backtest/status     — backtest cache age + last-run summary

Diagnostics:
  - GET /api/diag                — alignment diagnostics
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from ..app2_cache import (
    get_app2_cache_stats,
    get_all_cached_app2_signals,
    poll_app2_now,
    start_app2_cache_poller,
)
from ..backtest_runner import (
    get_backtest_cache_age_sec,
    get_cached_backtest,
    get_or_refresh_backtest,
    get_per_pair_winrate_lookup,
    run_backtest,
)
from ..candle_fetcher import (
    get_candle,
    get_candles_for_pair,
    get_candle_cache_stats,
    refresh_candles,
    start_candle_poller,
)
from ..signal_aggregator import aggregate_signals, aggregate_with_raw
from ..signal_normalize import CANDLE_SEC, candle_floor, get_candle_offset_sec
from ..snapshot_poller import get_snapshot, refresh_snapshot, start_poller

router = APIRouter(prefix="/api")

# Headers attached to every JSON response. Matches the original Next.js
# behavior — the dashboard polls frequently and must NEVER receive a cached
# copy, and the API is read by external clients that need CORS.
NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*",
}


def _json(payload: Any, *, status: int = 200) -> JSONResponse:
    """Wrap a dict/list in a JSONResponse carrying the no-store headers."""
    return JSONResponse(content=payload, status_code=status, headers=NO_STORE_HEADERS)


def _newest_candle_by_pair(signals: List[Any]) -> Dict[str, int]:
    """For each canonical pair, return the newest candle_time seen across
    the given list of signals. Used by ``/api/diag`` to compute the modal
    candle offset between two apps."""
    m: Dict[str, int] = {}
    for s in signals:
        cur = m.get(s.pair)
        if cur is None or s.candle_time > cur:
            m[s.pair] = s.candle_time
    return m


# ---------------------------------------------------------------------------
# /api/aggregated
# ---------------------------------------------------------------------------


@router.get("/aggregated")
async def get_aggregated(
    request: Request,
    freshness: int = Query(default=1800, ge=1, lt=86400),
):
    """Unified snapshot of call/put signals from the 3 source apps plus
    per-pair consensus (2-bot agree / 3-bot agree / conflict / single).

    Query params:
      - ``freshness`` (seconds, default 1800): how recent a signal must be
        to be considered "fresh" for consensus purposes.
    """
    try:
        result = await aggregate_signals(freshness)
        return _json(_serialize_aggregated(result))
    except Exception as e:
        return _json({"error": "aggregation_failed", "message": str(e)}, status=500)


# ---------------------------------------------------------------------------
# /api/snapshot  — cached aggregated snapshot, enriched with per-pair win rate
# ---------------------------------------------------------------------------


@router.get("/snapshot")
async def get_snapshot_route(
    request: Request,
    refresh: int = Query(default=0),
):
    """Latest cached aggregated snapshot. The background poller (started on
    first request) refreshes the cache adaptively, so this is a cheap read
    even when many clients poll frequently.

    Pass ``?refresh=1`` to force a fresh poll before returning.

    Enriched with per-pair win-rate info from the cached backtest (60s TTL).
    """
    start_poller()
    if refresh == 1:
        await refresh_snapshot()

    snap_data = get_snapshot()
    snapshot = snap_data["snapshot"]
    age_ms = snap_data["age_ms"]
    if snapshot is None:
        return _json(
            {"error": "no_snapshot_yet", "message": "First poll still running, retry in a moment."},
            status=503,
        )

    # Trigger a background backtest refresh if stale — non-blocking. The
    # result populates the per-pair win-rate lookup below on the NEXT poll.
    await get_or_refresh_backtest()
    winrate_lookup = get_per_pair_winrate_lookup(get_cached_backtest())

    out = _serialize_aggregated(snapshot, winrate_lookup=winrate_lookup)
    out["ageMs"] = age_ms
    out["backtestCacheAgeSec"] = round(get_backtest_cache_age_sec(), 1)
    out["now"] = int(datetime.now(timezone.utc).timestamp())
    return _json(out)


# ---------------------------------------------------------------------------
# /api/signal-feed  — flat chronological list of freshest signals across
# all 3 apps, with emitted-at + candle-time + lead/lag timing.
# ---------------------------------------------------------------------------


@router.get("/signal-feed")
async def get_signal_feed(
    request: Request,
    limit: int = Query(default=50, ge=1, le=300),
):
    """Flat chronological list of the freshest signals across all 3 apps.

    Each item carries enough timing info for the UI to show:
      - emittedAtUtc (HH:MM:SS) — when the source app emitted the signal
      - candleUtc    (HH:MM)    — which candle the signal is FOR
      - leadSec  (candle - emit; positive = prediction, negative = during candle)
      - lagSec   (now - candle; positive = candle in the past, negative = future)
      - status   (prediction | live | stale | look-ahead)
    """
    start_poller()
    snap_data = get_snapshot()
    snapshot = snap_data["snapshot"]
    if snapshot is None:
        return _json({"error": "no_snapshot_yet"}, status=503)

    now_sec = int(datetime.now(timezone.utc).timestamp())

    flat: List[Dict[str, Any]] = []
    for pair in snapshot.pairs:
        if not pair.latest_candle:
            continue
        for s in pair.latest_candle.signals:
            lead = s.candle_time - s.timestamp if s.timestamp > 0 else None
            lag = now_sec - s.candle_time
            flat.append({
                "pair": pair.pair,
                "displayPair": pair.display_pair,
                "category": pair.category,
                "source": s.source,
                "sourceName": s.source_name,
                "direction": s.direction,
                "confidence": s.confidence,
                "strength": s.strength,
                "emittedAt": s.timestamp,
                "emittedUtc": _fmt_hms(s.timestamp) if s.timestamp > 0 else None,
                "candleTime": s.candle_time,
                "candleUtc": _fmt_hm(s.candle_time) if s.candle_time > 0 else None,
                "ageSec": s.age_sec,
                "leadSec": lead,
                "lagSec": lag,
                "fresh": s.fresh,
                "cached": s.cached,
                "outcome": s.outcome,
                "strategy": s.strategy,
                "reasons": s.reasons,
                "validForCandle": s.valid_for_candle,
                "consensusLevel": pair.consensus.level,
                "consensusDirection": pair.consensus.direction,
            })

    flat.sort(key=lambda x: (x.get("emittedAt") or 0), reverse=True)
    return _json({
        "items": flat[:limit],
        "total": len(flat),
        "now": now_sec,
    })


# ---------------------------------------------------------------------------
# /api/pairs  — full per-pair breakdown incl. win rate (from cached backtest)
# ---------------------------------------------------------------------------


@router.get("/pairs")
async def get_pairs(
    request: Request,
    category: str = Query(default=""),
    level: str = Query(default=""),
    direction: str = Query(default=""),
    agree_count: int = Query(default=0, ge=0, le=3),
    app1_dir: str = Query(default=""),
    app2_dir: str = Query(default=""),
    app3_dir: str = Query(default=""),
    min_winrate_60min: float = Query(default=0.0, ge=0.0, le=100.0),
    candle_fresh_sec: int = Query(default=0, ge=0, le=600),
    q: str = Query(default=""),
):
    """Lightweight per-pair listing with filters. Reads from the cached
    snapshot — cheap, returns in <50ms even with hundreds of pairs.

    Each pair row carries the new flat column structure:
      - marketType       (otc | real)
      - candleUtc        (HH:MM UTC of the latest candle this signal is for)
      - pair / displayPair
      - app1Prediction   (CALL | PUT | null when missing)
      - app2Prediction   (CALL | PUT | null)
      - app3Prediction   (CALL | PUT | null)
      - agreeCount       (1 | 2 | 3 — how many apps agree on the final dir)
      - agreeLevel       (3-agree | 2-agree | conflict | 1-only)
      - finalPrediction  (consensus direction)
      - entryTimeUtc     (HH:MM UTC — when to enter, = candle open)
      - winRate60Min     (last-60-minute win rate, from cached backtest)
      - gradedTotal60Min (how many graded clusters in the last 60 min)
      - signals          (full per-app signal list — shown in expandable row)

    Filters: category, level, direction, agree_count, app{1,2,3}_dir,
    min_winrate_60min (exclude pairs with WR below this in last 60 min),
    candle_fresh_sec (only pairs with a candle newer than now - this),
    q (pair name substring).
    """
    start_poller()
    snap_data = get_snapshot()
    snapshot = snap_data["snapshot"]
    if snapshot is None:
        return _json({"error": "no_snapshot_yet"}, status=503)

    await get_or_refresh_backtest()
    winrate_lookup = get_per_pair_winrate_lookup(get_cached_backtest())
    now_sec = int(datetime.now(timezone.utc).timestamp())

    out: List[Dict[str, Any]] = []
    for p in snapshot.pairs:
        # ---- Filters ----
        if category and p.category != category:
            continue
        if level and p.consensus.level != level:
            continue
        if direction and (p.consensus.direction or "") != direction:
            continue
        if q and q.lower() not in p.display_pair.lower():
            continue

        latest = p.latest_candle
        # Build a per-app prediction lookup from the latest candle's signals.
        app_pred: Dict[str, Optional[str]] = {"app1": None, "app2": None, "app3": None}
        app_signal_detail: Dict[str, Optional[Dict[str, Any]]] = {
            "app1": None, "app2": None, "app3": None,
        }
        if latest:
            for s in latest.signals:
                if s.source in app_pred and app_pred[s.source] is None:
                    app_pred[s.source] = s.direction
                    app_signal_detail[s.source] = {
                        "source": s.source,
                        "sourceName": s.source_name,
                        "direction": s.direction,
                        "confidence": s.confidence,
                        "strength": s.strength,
                        "emittedAt": s.timestamp,
                        "emittedUtc": _fmt_hms(s.timestamp) if s.timestamp > 0 else None,
                        "candleTime": s.candle_time,
                        "candleUtc": _fmt_hm(s.candle_time) if s.candle_time > 0 else None,
                        "leadSec": (s.candle_time - s.timestamp) if s.timestamp > 0 else None,
                        "ageSec": s.age_sec,
                        "outcome": s.outcome,
                        "strategy": s.strategy,
                        "reasons": s.reasons,
                        "validForCandle": s.valid_for_candle,
                        "fresh": s.fresh,
                        "cached": s.cached,
                    }

        # ---- agree_count filter ----
        final_dir = p.consensus.direction
        agreeing_count = sum(1 for v in app_pred.values() if v == final_dir) if final_dir else 0
        if agree_count and agreeing_count < agree_count:
            continue

        # ---- per-app direction filters ----
        if app1_dir and (app_pred["app1"] or "") != app1_dir:
            continue
        if app2_dir and (app_pred["app2"] or "") != app2_dir:
            continue
        if app3_dir and (app_pred["app3"] or "") != app3_dir:
            continue

        # ---- candle freshness filter ----
        candle_time = latest.candle_time if latest else 0
        if candle_fresh_sec and candle_time > 0:
            if (now_sec - candle_time) > candle_fresh_sec:
                continue

        # ---- win rate 60min filter ----
        wr = winrate_lookup.get(p.pair, {})
        wr60 = wr.get("winRate60Min")
        if min_winrate_60min > 0:
            if wr60 is None or wr60 < min_winrate_60min:
                continue

        entry_time_utc = _fmt_hm(candle_time) if candle_time > 0 else None

        out.append({
            "pair": p.pair,
            "displayPair": p.display_pair,
            "category": p.category,
            "marketType": p.category,  # alias for clarity in UI
            "candleTime": candle_time,
            "candleUtc": entry_time_utc,
            "entryTimeUtc": entry_time_utc,  # entry = candle open
            # Per-app predictions (flat columns)
            "app1Prediction": app_pred["app1"],
            "app2Prediction": app_pred["app2"],
            "app3Prediction": app_pred["app3"],
            # Agreement
            "agreeCount": agreeing_count,
            "agreeLevel": p.consensus.level,
            "agreeingApps": p.consensus.agreeing_apps,
            "disagreeingApps": p.consensus.disagreeing_apps,
            "missingApps": p.consensus.missing_apps,
            # Final
            "finalPrediction": final_dir,
            "consensus": _serialize_consensus(p.consensus),
            # Win rate (60 min + 6h)
            "winRate60Min": wr60,
            "gradedTotal60Min": wr.get("gradedTotal60Min", 0),
            "wins60Min": wr.get("wins60Min", 0),
            "losses60Min": wr.get("losses60Min", 0),
            "winRate": wr.get("winRate"),
            "gradedTotal": wr.get("gradedTotal", 0),
            "levelStats": wr.get("levels", {}),
            # Per-app-pair win rate (app1+app2, app1+app3, app2+app3, all-3,
            # plus singletons) from the cached backtest. Surfaced in the
            # Signals tab expanded row and the History "App Pair Leaders" sub-tab.
            "appPairStats": wr.get("appPairStats", {}),
            # Other stats
            "freshCount": p.fresh_count,
            "callCount": p.call_count,
            "putCount": p.put_count,
            "neutralCount": p.neutral_count,
            # Full per-app signal details (for the expandable row)
            "signals": list(app_signal_detail.values()),
            "latestCandle": _serialize_candle_consensus(latest) if latest else None,
            "now": now_sec,
        })

    # Sort: 3-agree first, then by 60-min win rate desc, then by pair name
    level_rank = {"3-agree": 0, "2-agree": 1, "conflict": 2, "1-only": 3, "none": 4}
    out.sort(key=lambda x: (
        level_rank.get(x.get("agreeLevel") or "none", 5),
        -(x.get("winRate60Min") or -1),
        x.get("displayPair") or "",
    ))

    return _json({
        "items": out,
        "total": len(out),
        "now": now_sec,
        "backtestCacheAgeSec": round(get_backtest_cache_age_sec(), 1),
    })


# ---------------------------------------------------------------------------
# /api/pair/{pair}  — single-pair detail (signals + candles + win rate)
# ---------------------------------------------------------------------------


@router.get("/pair/{pair}")
async def get_pair_detail(
    pair: str,
    request: Request,
    candle_limit: int = Query(default=60, ge=1, le=300),
    history_minutes: int = Query(default=60, ge=1, le=360),
):
    """Single-pair drilldown — used by the Signals tab row-tap drawer.

    Carries everything the drawer needs to render the pair detail:
      - latest per-app signals (live)
      - latest candle consensus
      - per-pair OHLC candle history (mini chart)
      - per-pair App 2 historical cache
      - per-pair win rate (overall + 60-min) + per-level + per-app-subset
      - **clusterHistory** — per-candle signal history filtered to the last
        ``history_minutes`` minutes. Each row carries:
          candleUtc, level, direction, app_subset_key (1+2 / 1+3 / 2+3 / all-3
          / singleton), per-app direction chip (app1/app2/app3 directions),
          per-app outcome chip (WIN/LOSS/—), consensus outcome (WIN/LOSS/DRAW/—).
        Used by the drawer's "Signal History (Last 60 min)" table.
      - **history60BySubset** — one-row-per-app-subset summary (total / wins /
        losses / winRate) over the same window. Lets the drawer render a
        compact "1+2: 3W/1L (75%)" strip above the per-candle table.
    """
    start_poller()
    start_candle_poller()
    snap_data = get_snapshot()
    snapshot = snap_data["snapshot"]

    # Look up the pair in the snapshot if available (gives us consensus).
    pair_obj = None
    if snapshot is not None:
        for p in snapshot.pairs:
            if p.pair == pair:
                pair_obj = p
                break

    await get_or_refresh_backtest()
    winrate_lookup = get_per_pair_winrate_lookup(get_cached_backtest())
    wr = winrate_lookup.get(pair, {})
    now_sec = int(datetime.now(timezone.utc).timestamp())

    # Per-pair signal history from the app2 cache (gives emitted-at times).
    cached_app2 = [c for c in get_all_cached_app2_signals() if c.pair == pair]
    cached_app2.sort(key=lambda c: c.candle_time, reverse=True)

    candles = get_candles_for_pair(pair, candle_limit)
    if not candles:
        try:
            await refresh_candles()
        except Exception:
            pass
        candles = get_candles_for_pair(pair, candle_limit)

    # ---- Per-candle cluster history (last N minutes) ----
    # `history60Min` is pre-filtered to the last 60 minutes in the backtest.
    # If the caller asks for a different window we filter the full `history`
    # list ourselves. Anything older than the backtest's 6h lookback is
    # simply absent.
    cluster_history_full = wr.get("history60Min", [])
    if history_minutes == 60:
        cluster_history = cluster_history_full
    else:
        cutoff = now_sec - history_minutes * 60
        # Fall back to the full per-pair history (cached backtest perPair[*].history)
        # if the 60-min slice doesn't cover the requested window.
        cached = get_cached_backtest() or {}
        full_history = []
        for p in cached.get("perPair", []):
            if p.get("pair") == pair:
                full_history = p.get("history", [])
                break
        cluster_history = [c for c in full_history if c.get("ts", 0) >= cutoff]
    # Attach candleUtc + relative age so the UI doesn't have to compute it.
    for c in cluster_history:
        c["candleUtc"] = _fmt_hm(c.get("ts", 0)) if c.get("ts", 0) else None
        c["ageSec"] = now_sec - c.get("ts", 0) if c.get("ts", 0) else None
    # Per-subset summary already shipped in wr["history60BySubset"] for the
    # default 60-min window; for other windows we re-derive it on the fly.
    history_by_subset = wr.get("history60BySubset", {})
    if history_minutes != 60:
        history_by_subset = _build_subset_summary(cluster_history)

    return _json({
        "pair": pair,
        "displayPair": pair_obj.display_pair if pair_obj else pair,
        "category": pair_obj.category if pair_obj else ("otc" if pair.endswith("_otc") else "real"),
        "consensus": _serialize_consensus(pair_obj.consensus) if pair_obj else None,
        "freshCount": pair_obj.fresh_count if pair_obj else 0,
        "callCount": pair_obj.call_count if pair_obj else 0,
        "putCount": pair_obj.put_count if pair_obj else 0,
        "neutralCount": pair_obj.neutral_count if pair_obj else 0,
        "signals": [_serialize_signal(s) for s in (pair_obj.signals if pair_obj else [])],
        "latestCandle": _serialize_candle_consensus(pair_obj.latest_candle) if pair_obj and pair_obj.latest_candle else None,
        "candles": [_serialize_candle(c) for c in candles[:candle_limit]],
        "app2History": [
            {
                "candleTime": c.candle_time,
                "candleUtc": _fmt_hm(c.candle_time),
                "direction": c.signal,
                "firstSeenSec": c.first_seen_sec,
                "firstSeenUtc": _fmt_hms(c.first_seen_sec) if c.first_seen_sec > 0 else None,
                "leadSec": c.candle_time - c.first_seen_sec if c.first_seen_sec > 0 else None,
                "buyerPct": c.buyer_pct,
                "sellerPct": c.seller_pct,
            }
            for c in cached_app2[:candle_limit]
        ],
        "winRate": wr.get("winRate"),
        "gradedTotal": wr.get("gradedTotal", 0),
        "levelStats": wr.get("levels", {}),
        # Per-pair × per-app-subset win rate (app1, app2, app3, app1+app2,
        # app1+app3, app2+app3, app1+app2+app3). Surfaced in the drawer.
        "appPairStats": wr.get("appPairStats", {}),
        # NEW — per-candle signal history (last `history_minutes` minutes).
        # Each row carries: ts, candleUtc, ageSec, level, direction,
        # app_subset_key, app_directions{app1,app2,app3}, app_outcomes,
        # appOutcomeLabels, outcome, outcomeLabel, agreeing_apps.
        "clusterHistory": cluster_history,
        "clusterHistoryMinutes": history_minutes,
        # NEW — per-app-subset summary over the same window. Keys: app1, app2,
        # app3, app1+app2, app1+app3, app2+app3, app1+app2+app3.
        "historyBySubset": history_by_subset,
        "now": now_sec,
    })


# ---------------------------------------------------------------------------
# /api/pair/{pair}/history  — per-candle signal history (dedicated endpoint)
# ---------------------------------------------------------------------------


def _build_subset_summary(clusters: List[Dict[str, Any]]) -> Dict[str, dict]:
    """Aggregate a list of cluster dicts by ``app_subset_key`` into a stable
    one-row-per-subset summary. Mirrors the per-pair `history60BySubset`
    shape produced by ``backtest_runner.pair_to_dict`` so the UI can use the
    same rendering path regardless of the window length."""
    from ..backtest_runner import APP_SUBSET_KEYS
    buckets: Dict[str, Dict[str, int]] = {}
    for c in clusters:
        key = c.get("app_subset_key") or ""
        if not key:
            continue
        b = buckets.setdefault(key, {
            "total": 0, "win": 0, "loss": 0, "draw": 0, "unknown": 0,
            "call": 0, "put": 0,
        })
        b["total"] += 1
        outcome = c.get("outcome")
        if outcome == 1:
            b["win"] += 1
        elif outcome == 0:
            b["loss"] += 1
        elif c.get("agreeing_draw", 0):
            b["draw"] += 1
        else:
            b["unknown"] += 1
        d = c.get("direction")
        if d == "CALL":
            b["call"] += 1
        elif d == "PUT":
            b["put"] += 1
    out: Dict[str, dict] = {}
    for key in APP_SUBSET_KEYS:
        b = buckets.get(key, {
            "total": 0, "win": 0, "loss": 0, "draw": 0, "unknown": 0,
            "call": 0, "put": 0,
        })
        graded = b["win"] + b["loss"]
        out[key] = {
            **b,
            "gradedTotal": graded,
            "winRate": round((b["win"] / graded) * 100, 1) if graded else None,
        }
    for key, b in buckets.items():
        if key in out:
            continue
        graded = b["win"] + b["loss"]
        out[key] = {
            **b,
            "gradedTotal": graded,
            "winRate": round((b["win"] / graded) * 100, 1) if graded else None,
        }
    return out


@router.get("/pair/{pair}/history")
async def get_pair_history(
    pair: str,
    request: Request,
    minutes: int = Query(default=60, ge=1, le=360),
    subset: str = Query(default=""),
):
    """Dedicated per-pair signal history endpoint.

    Returns the candle-by-candle cluster history for one pair, filtered to
    the last ``minutes`` minutes (default 60). Each cluster carries:

      - ts (unix sec, candle_time)
      - candleUtc (HH:MM UTC)
      - ageSec (now - ts)
      - level (3-agree / 2-agree / conflict / 1-only)
      - direction (CALL / PUT / null)
      - app_subset_key (e.g. "app1+app2", "app1+app3", "app2+app3",
        "app1+app2+app3", or singleton "app1" / "app2" / "app3")
      - app_directions (per-app direction, e.g. {"app1":"CALL","app2":"CALL","app3":"PUT"})
      - app_outcomes (per-app outcome, 1/0/null)
      - appOutcomeLabels (per-app "WIN"/"LOSS"/"—")
      - outcome (1 / 0 / null)
      - outcomeLabel ("WIN" / "LOSS" / "DRAW" / "—")
      - agreeing_apps (list of app ids that voted for the consensus direction)

    Optional ``subset`` query filters by app_subset_key (e.g. ``?subset=app1+app2``).
    Used by the per-pair drawer's "Signal History (Last 60 min)" table when
    the user wants only one agreement type (1+2 / 1+3 / 2+3 / all-3).
    """
    start_poller()
    await get_or_refresh_backtest()
    winrate_lookup = get_per_pair_winrate_lookup(get_cached_backtest())
    wr = winrate_lookup.get(pair, {})
    now_sec = int(datetime.now(timezone.utc).timestamp())

    cached = get_cached_backtest() or {}
    full_history: List[Dict[str, Any]] = []
    for p in cached.get("perPair", []):
        if p.get("pair") == pair:
            full_history = p.get("history", [])
            break

    cutoff = now_sec - minutes * 60
    history = [c for c in full_history if c.get("ts", 0) >= cutoff]
    if subset:
        history = [c for c in history if c.get("app_subset_key") == subset]
    for c in history:
        c["candleUtc"] = _fmt_hm(c.get("ts", 0)) if c.get("ts", 0) else None
        c["ageSec"] = now_sec - c.get("ts", 0) if c.get("ts", 0) else None
    history.sort(key=lambda c: c.get("ts", 0), reverse=True)

    history_by_subset = _build_subset_summary(history)

    # Per-subset summary across the WHOLE window (not just the filtered subset)
    # — gives the UI a complete strip even when the user picks one subset.
    full_window = [c for c in full_history if c.get("ts", 0) >= cutoff]
    full_by_subset = _build_subset_summary(full_window)

    return _json({
        "pair": pair,
        "minutes": minutes,
        "subset": subset or None,
        "items": history,
        "total": len(history),
        # Per-subset summary over the requested window (all subsets, even if
        # `subset` filter is set — so the UI can show non-filtered chips too).
        "bySubset": full_by_subset,
        # Per-subset summary over only the filtered rows (when subset is set,
        # this will only have one non-zero entry).
        "bySubsetFiltered": history_by_subset,
        "winRate60Min": wr.get("winRate60Min"),
        "gradedTotal60Min": wr.get("gradedTotal60Min", 0),
        "wins60Min": wr.get("wins60Min", 0),
        "losses60Min": wr.get("losses60Min", 0),
        "now": now_sec,
    })


# ---------------------------------------------------------------------------
# /api/candles  — per-pair OHLC candle history
# ---------------------------------------------------------------------------


@router.get("/candles")
async def get_candles(
    request: Request,
    pair: str = Query(default=""),
    limit: int = Query(default=60, ge=1, le=500),
):
    """Per-pair candle history, newest first. Used by the per-pair candle
    chart in the History tab.

    The candle cache is shared with the backtest poller; this endpoint just
    reads from it. If the cache is empty (cold start), we trigger a refresh
    and return what we have — the client can re-poll in a moment.
    """
    start_candle_poller()
    if not pair:
        return _json({"error": "missing_pair", "message": "Pass ?pair=USDCOP_otc"}, status=400)

    candles = get_candles_for_pair(pair, limit)
    if not candles:
        # Cold cache — refresh and retry once.
        try:
            await refresh_candles()
        except Exception:
            pass
        candles = get_candles_for_pair(pair, limit)

    return _json({
        "pair": pair,
        "candles": [_serialize_candle(c) for c in candles[:limit]],
        "count": min(len(candles), limit),
        "total": len(candles),
    })


# ---------------------------------------------------------------------------
# /api/backtest  — run or read cached consensus backtest
# ---------------------------------------------------------------------------


@router.get("/backtest")
async def get_backtest(request: Request):
    """Runs a live backtest against the 3 source apps' historical signal
    data, computes consensus accuracy, and returns the structured result.

    Also writes the result to the backtest cache so subsequent snapshot
    polls can read per-pair win rates without re-running.
    """
    try:
        result = await run_backtest()
        return _json(result)
    except Exception as e:
        return _json({"error": "backtest_failed", "message": str(e)}, status=500)


@router.get("/backtest/status")
async def get_backtest_status(request: Request):
    """Cheap status check — backtest cache age + verdict + total signals.

    Used by the History tab header so we can show "last backtest 47s ago"
    without re-running it."""
    cached = get_cached_backtest()
    return _json({
        "cacheAgeSec": round(get_backtest_cache_age_sec(), 1),
        "hasResult": cached is not None,
        "verdict": cached.get("verdict") if cached else None,
        "totalSignals": cached.get("totalSignals") if cached else 0,
        "totalClusters": cached.get("totalClusters") if cached else 0,
        "perPairCount": len(cached.get("perPair", [])) if cached else 0,
        "timestamp": cached.get("timestamp") if cached else None,
    })


@router.get("/app-pair-leaders")
async def get_app_pair_leaders(request: Request):
    """Per-app-subset leaderboard from the cached backtest.

    For each canonical app subset (``app1``, ``app2``, ``app3``,
    ``app1+app2``, ``app1+app3``, ``app2+app3``, ``app1+app2+app3``),
    returns the top 10 pairs by graded win rate (min 3 graded samples).

    Also returns a global aggregate per app subset, so the dashboard can
    answer both:

        - "Which pair of apps performs best globally?"
        - "For each pair of apps, which pairs are they best on?"
    """
    start_app2_cache_poller()
    start_candle_poller()
    cached = get_cached_backtest()
    if cached is None:
        # Cold cache — trigger a background refresh; client can re-poll.
        await get_or_refresh_backtest()
        cached = get_cached_backtest()

    leaders = cached.get("appPairLeaders", {}) if cached else {}

    # Global aggregate per app subset (across all pairs).
    APP_SUBSET_KEYS = ["app1", "app2", "app3", "app1+app2", "app1+app3", "app2+app3", "app1+app2+app3"]
    global_agg: Dict[str, Dict[str, int]] = {k: {"total": 0, "win": 0, "loss": 0, "unknown": 0, "draw": 0} for k in APP_SUBSET_KEYS}
    for p in (cached.get("perPair", []) if cached else []):
        for key, st in (p.get("appPairStats") or {}).items():
            if key not in global_agg:
                global_agg[key] = {"total": 0, "win": 0, "loss": 0, "unknown": 0, "draw": 0}
            agg = global_agg[key]
            agg["total"] += st.get("total", 0)
            agg["win"] += st.get("win", 0)
            agg["loss"] += st.get("loss", 0)
            agg["unknown"] += st.get("unknown", 0)
            agg["draw"] += st.get("draw", 0)
    global_summary = {}
    for key, agg in global_agg.items():
        graded = agg["win"] + agg["loss"]
        global_summary[key] = {
            **agg,
            "gradedTotal": graded,
            "winRate": round((agg["win"] / graded) * 100, 1) if graded else None,
        }

    return _json({
        "appPairLeaders": leaders,
        "appPairGlobal": global_summary,
        "cacheAgeSec": round(get_backtest_cache_age_sec(), 1),
        "verdict": cached.get("verdict") if cached else None,
        "subsetKeys": APP_SUBSET_KEYS,
    })


# ---------------------------------------------------------------------------
# /api/diag  — alignment diagnostics (engineer-facing; hidden from main nav)
# ---------------------------------------------------------------------------


@router.get("/diag")
async def get_diag(
    request: Request,
    poll: int = Query(default=0),
):
    """Alignment diagnostics. Answers, with numbers instead of guesswork:

    - Is each app returning rows at all, and how many are dropped (and why)?
    - Do the three apps agree on pair names after canonicalization?
    - Do they put their signals in the SAME candle bucket? ``offsets`` reports,
      for each app pair, the distribution of candle differences measured on
      pairs where both apps have a recent signal. A modal offset of 0 means
      they are aligned; a consistent ±1 means one app labels the candle it
      analysed while the other labels the candle it predicts — fix that by
      setting e.g. ``APP2_CANDLE_OFFSET=1``.

    This endpoint is the thing to look at first when an app's column on the
    dashboard is empty.
    """
    start_app2_cache_poller()
    if poll == 1:
        await poll_app2_now()

    raw = await aggregate_with_raw(1800)
    now_sec = raw["now_sec"]
    per_app = raw["per_app"]
    current_candle = candle_floor(now_sec)

    APPS = ["app1", "app2", "app3"]

    # ---- Per-app summary ----
    apps_summary = []
    for app_id in APPS:
        r = per_app[app_id]
        sigs = r.signals
        candle_times = [s.candle_time for s in sigs if s.candle_time > 0]
        recent = [s for s in sigs if s.candle_time >= current_candle - 5 * CANDLE_SEC]
        apps_summary.append({
            "app": app_id,
            "health": r.health,
            "error": r.error,
            "detail": r.detail,
            "rawRows": r.raw_count,
            "normalizedSignals": len(sigs),
            "skipped": r.skipped,
            "candleOffsetApplied": get_candle_offset_sec(app_id) // CANDLE_SEC,
            "distinctPairs": sorted({s.pair for s in sigs}),
            "newestCandle": max(candle_times) if candle_times else None,
            "oldestCandle": min(candle_times) if candle_times else None,
            "newestCandleLagCandles": (current_candle - max(candle_times)) // CANDLE_SEC if candle_times else None,
            "signalsInLast5Candles": len(recent),
            "validForOwnCandle": sum(1 for s in sigs if s.valid_for_candle),
            "invalidForOwnCandle": sum(1 for s in sigs if not s.valid_for_candle),
            "sample": [_serialize_signal_sample(s) for s in sorted(sigs, key=lambda x: x.candle_time, reverse=True)[:5]],
        })

    # ---- Pair-name overlap ----
    pair_sets = {
        "app1": {s.pair for s in per_app["app1"].signals},
        "app2": {s.pair for s in per_app["app2"].signals},
        "app3": {s.pair for s in per_app["app3"].signals},
    }
    pair_combos = [("app1", "app2"), ("app1", "app3"), ("app2", "app3")]
    pair_overlap = []
    for a, b in pair_combos:
        pair_overlap.append({
            "apps": f"{a}↔{b}",
            "shared": sorted(pair_sets[a] & pair_sets[b]),
            "onlyIn": {
                a: sorted(pair_sets[a] - pair_sets[b]),
                b: sorted(pair_sets[b] - pair_sets[a]),
            },
        })

    # ---- Candle offset between apps ----
    newest_by_app = {
        app_id: _newest_candle_by_pair(per_app[app_id].signals)
        for app_id in APPS
    }
    offsets = []
    for a, b in pair_combos:
        ma = newest_by_app[a]
        mb = newest_by_app[b]
        diffs: Dict[str, int] = {}
        samples = 0
        for pair, ca in ma.items():
            cb = mb.get(pair)
            if cb is None:
                continue
            d = (ca - cb) // CANDLE_SEC
            if abs(d) > 10:
                continue
            key = str(d)
            diffs[key] = diffs.get(key, 0) + 1
            samples += 1
        modal = None
        modal_count = 0
        for d, n in diffs.items():
            if n > modal_count:
                modal_count = n
                modal = int(d)
        if modal is None:
            hint = "no shared pairs with comparable candles"
        elif modal == 0:
            hint = "aligned — no offset needed"
        else:
            hint = (
                f"{a} runs {modal} candle(s) ahead of {b}; "
                f"consider {b.upper()}_CANDLE_OFFSET={modal} or {a.upper()}_CANDLE_OFFSET={-modal}"
            )
        offsets.append({
            "apps": f"{a}-{b}",
            "samples": samples,
            "histogram": diffs,
            "modalOffsetCandles": modal,
            "confidence": round(modal_count / samples, 2) if samples > 0 else 0,
            "hint": hint,
        })

    # ---- Candle coverage (how many candles actually have 2 or 3 apps?) ----
    bucket: Dict[str, set] = {}
    for app_id in APPS:
        for s in per_app[app_id].signals:
            if not s.valid_for_candle:
                continue
            if s.candle_time < current_candle - 30 * CANDLE_SEC:
                continue
            key = f"{s.pair}|{s.candle_time}"
            bucket.setdefault(key, set()).add(app_id)

    coverage = {"oneApp": 0, "twoApps": 0, "threeApps": 0}
    app_presence = {"app1": 0, "app2": 0, "app3": 0}
    for s in bucket.values():
        if len(s) == 1:
            coverage["oneApp"] += 1
        elif len(s) == 2:
            coverage["twoApps"] += 1
        elif len(s) >= 3:
            coverage["threeApps"] += 1
        for app_id in s:
            app_presence[app_id] += 1

    return _json({
        "now": {
            "unixSec": now_sec,
            "currentCandle": current_candle,
            "iso": datetime.fromtimestamp(now_sec, tz=timezone.utc).isoformat(),
        },
        "apps": apps_summary,
        "app2Cache": get_app2_cache_stats(),
        "candleCache": get_candle_cache_stats(),
        "pairOverlap": pair_overlap,
        "offsets": offsets,
        "candleCoverageLast30Candles": {**coverage, "buckets": len(bucket), "appPresence": app_presence},
        "notes": [
            "offsets.modalOffsetCandles should be 0 for every app pair. A stable non-zero value means the apps label candles differently — set APP{N}_CANDLE_OFFSET to correct it.",
            "pairOverlap.onlyIn shows pair names one app has and the other doesn't — after canonicalization these should only be genuinely different assets.",
            "app2Cache.entries growing over time confirms the App 2 history poller is recording candles.",
            "apps[].rawRows/normalizedSignals can stay flat even when an app is perfectly healthy — some upstreams (e.g. App 3's historical endpoint) return a fixed-size window of their newest rows, so the count plateaus while the content keeps rotating fresh underneath. Trust apps[].newestCandleLagCandles (and the freshness badge on this page) to judge whether an app is actually stale, not the raw count.",
        ],
    })


# ---------------------------------------------------------------------------
# Serialization helpers — the aggregator uses dataclasses, but the dashboard
# expects JSON-shaped camelCase objects matching the original TS response.
# ---------------------------------------------------------------------------


def _fmt_hm(ts: int) -> str:
    if not ts or ts <= 0:
        return "—"
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M")


def _fmt_hms(ts: int) -> str:
    if not ts or ts <= 0:
        return "—"
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M:%S")


def _signal_timing_status(lead_sec: int, lag_sec: int) -> str:
    """Classify a signal's timing for the UI:
    - 'prediction'  — emitted before its candle (lead > 0)
    - 'live'        — emitted during its candle (-60 <= lead <= 0)
    - 'look-ahead'  — emitted after candle closed (lead < -60 — suspicious!)
    - 'stale'       — candle is well in the past (lag > 120)
    """
    if lead_sec is None:
        return "unknown"
    if lead_sec < -CANDLE_SEC - 5:
        return "look-ahead"
    if lead_sec > 0:
        return "prediction"
    if lag_sec > 120:
        return "stale"
    return "live"


def _serialize_aggregated(agg, *, winrate_lookup: Optional[Dict[str, Dict[str, Any]]] = None) -> dict:
    winrate_lookup = winrate_lookup or {}
    return {
        "timestamp": agg.timestamp,
        "freshnessWindowSec": agg.freshness_window_sec,
        "apps": [_serialize_app(a) for a in agg.apps],
        "pairs": [_serialize_pair(p, winrate_lookup=winrate_lookup) for p in agg.pairs],
        "summary": {
            "totalPairs": agg.summary["totalPairs"],
            "threeBotAgree": [_serialize_pair(p, winrate_lookup=winrate_lookup) for p in agg.summary["threeBotAgree"]],
            "twoBotAgree": [_serialize_pair(p, winrate_lookup=winrate_lookup) for p in agg.summary["twoBotAgree"]],
            "conflicts": [_serialize_pair(p, winrate_lookup=winrate_lookup) for p in agg.summary["conflicts"]],
            "singleOnly": [_serialize_pair(p, winrate_lookup=winrate_lookup) for p in agg.summary["singleOnly"]],
            "pairsByDirection": agg.summary["pairsByDirection"],
        },
    }


def _serialize_app(a) -> dict:
    return {
        "id": a.id,
        "name": a.name,
        "url": a.url,
        "online": a.online,
        "lastChecked": a.last_checked,
        "signalCount": a.signal_count,
        "freshSignalCount": a.fresh_signal_count,
        "health": a.health,
        "detail": a.detail,
        "live": a.live,
        "tokenExpired": a.token_expired,
        "uptimeSec": a.uptime_sec,
        "activeStreams": a.active_streams,
        "latencyMs": a.latency_ms,
        "rawCount": a.raw_count,
        "skipped": a.skipped,
        "error": a.error,
    }


def _serialize_pair(p, *, winrate_lookup: Optional[Dict[str, Dict[str, Any]]] = None) -> dict:
    winrate_lookup = winrate_lookup or {}
    wr = winrate_lookup.get(p.pair, {})
    out = {
        "pair": p.pair,
        "displayPair": p.display_pair,
        "category": p.category,
        "signals": [_serialize_signal(s) for s in p.signals],
        "candles": [_serialize_candle_consensus(c) for c in p.candles],
        "latestCandle": _serialize_candle_consensus(p.latest_candle) if p.latest_candle else None,
        "freshCount": p.fresh_count,
        "callCount": p.call_count,
        "putCount": p.put_count,
        "neutralCount": p.neutral_count,
        "consensus": _serialize_consensus(p.consensus),
        # Per-pair win rate from the cached backtest (60s TTL). None when no
        # graded data is available yet (cold start / pair never had a closed
        # candle in the lookback window).
        "winRate": wr.get("winRate"),
        "gradedTotal": wr.get("gradedTotal", 0),
        "levelStats": wr.get("levels", {}),
        # 60-minute win rate (last-60-minute rolling window from cached
        # backtest cluster history). Surfaced on the Signals tab row.
        "winRate60Min": wr.get("winRate60Min"),
        "gradedTotal60Min": wr.get("gradedTotal60Min", 0),
        "wins60Min": wr.get("wins60Min", 0),
        "losses60Min": wr.get("losses60Min", 0),
        # Per-pair × per-app-subset win rate (app1, app2, app3, app1+app2,
        # app1+app3, app2+app3, app1+app2+app3). Surfaced in the Signals tab
        # expanded row and the History "App Pair Leaders" sub-tab.
        "appPairStats": wr.get("appPairStats", {}),
    }
    return out


def _serialize_candle_consensus(c) -> dict:
    return {
        "pair": c.pair,
        "displayPair": c.display_pair,
        "category": c.category,
        "candleTime": c.candle_time,
        "signals": [_serialize_signal(s) for s in c.signals],
        "freshCount": c.fresh_count,
        "callCount": c.call_count,
        "putCount": c.put_count,
        "neutralCount": c.neutral_count,
        "consensus": _serialize_consensus(c.consensus),
    }


def _serialize_consensus(c) -> dict:
    return {
        "level": c.level,
        "direction": c.direction,
        "agreeingApps": c.agreeing_apps,
        "disagreeingApps": c.disagreeing_apps,
        "missingApps": c.missing_apps,
        "invalidApps": c.invalid_apps,
    }


def _serialize_signal(s) -> dict:
    lead = s.candle_time - s.timestamp if s.timestamp > 0 else None
    return {
        "source": s.source,
        "sourceName": s.source_name,
        "pair": s.pair,
        "displayPair": s.display_pair,
        "direction": s.direction,
        "confidence": s.confidence,
        "strength": s.strength,
        "timestamp": s.timestamp,
        "emittedUtc": _fmt_hms(s.timestamp) if s.timestamp > 0 else None,
        "candleTime": s.candle_time,
        "candleUtc": _fmt_hm(s.candle_time) if s.candle_time > 0 else None,
        "leadSec": lead,
        "ageSec": s.age_sec,
        "outcome": s.outcome,
        "strategy": s.strategy,
        "reasons": s.reasons,
        "validForCandle": s.valid_for_candle,
        "fresh": s.fresh,
        "cached": s.cached,
    }


def _serialize_signal_sample(s) -> dict:
    lead = s.candle_time - s.timestamp
    return {
        "pair": s.pair,
        "direction": s.direction,
        "candleTime": s.candle_time,
        "candleUtc": _fmt_hm(s.candle_time),
        "emittedAt": s.timestamp,
        "emittedUtc": _fmt_hms(s.timestamp) if s.timestamp > 0 else None,
        "leadSec": lead,
        "timingStatus": _signal_timing_status(lead, 0),
        "validForCandle": s.valid_for_candle,
        "fresh": s.fresh,
        "cached": s.cached,
    }


def _serialize_candle(c) -> dict:
    return {
        "pair": c.pair,
        "candleTime": c.candle_time,
        "candleUtc": _fmt_hm(c.candle_time),
        "open": c.open,
        "high": c.high,
        "low": c.low,
        "close": c.close,
        "diff": (c.close - c.open) if (c.close is not None and c.open is not None) else None,
        "result": c.result,
        "app3Direction": c.app3_direction,
        "fetchedAt": c.fetched_at,
    }
