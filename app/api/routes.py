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
from typing import Any, Dict, List

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
    q: str = Query(default=""),
):
    """Lightweight per-pair listing with filters. Reads from the cached
    snapshot — cheap, returns in <50ms even with hundreds of pairs."""
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
        if category and p.category != category:
            continue
        if level and p.consensus.level != level:
            continue
        if direction and (p.consensus.direction or "") != direction:
            continue
        if q and q.lower() not in p.display_pair.lower():
            continue
        wr = winrate_lookup.get(p.pair, {})
        latest = p.latest_candle
        out.append({
            "pair": p.pair,
            "displayPair": p.display_pair,
            "category": p.category,
            "consensus": _serialize_consensus(p.consensus),
            "freshCount": p.fresh_count,
            "callCount": p.call_count,
            "putCount": p.put_count,
            "neutralCount": p.neutral_count,
            "latestCandle": _serialize_candle_consensus(latest) if latest else None,
            "winRate": wr.get("winRate"),
            "gradedTotal": wr.get("gradedTotal", 0),
            "levelStats": wr.get("levels", {}),
            "now": now_sec,
        })

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
):
    """Single-pair drilldown — used by the Signals tab row-tap drawer."""
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
