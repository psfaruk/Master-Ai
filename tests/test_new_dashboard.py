"""Tests for the new dashboard endpoints and per-pair win-rate enrichment.

Covers:
  - /api/snapshot now carries winRate, gradedTotal, levelStats per pair
  - /api/signal-feed returns flat list with emittedUtc, candleUtc, leadSec, lagSec
  - /api/pairs supports category/level/direction/q filters
  - /api/pair/{pair} returns detail with candles + app2History + winRate
  - /api/backtest/status returns cache age + verdict
  - backtest_runner caches its result and get_per_pair_winrate_lookup builds
    the pair → winRate lookup correctly
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

import pytest

from app.backtest_runner import (
    BacktestCache,
    _get_cache,
    get_backtest_cache_age_sec,
    get_cached_backtest,
    get_per_pair_winrate_lookup,
)
from app.signal_normalize import canonical_pair


async def _noop_coro():
    """A no-op awaitable that returns None — used to stub the
    `get_or_refresh_backtest()` async call in routes."""
    return None


# ---------------------------------------------------------------------------
# Fixtures — faked aggregator that returns a known snapshot shape
# ---------------------------------------------------------------------------


class _FakeConsensus:
    def __init__(self, level, direction, agreeing=None, disagreeing=None, missing=None, invalid=None):
        self.level = level
        self.direction = direction
        self.agreeing_apps = agreeing or []
        self.disagreeing_apps = disagreeing or []
        self.missing_apps = missing or []
        self.invalid_apps = invalid or []


class _FakeSignal:
    def __init__(self, source, pair, direction, timestamp, candle_time, source_name="X", display_pair=None, confidence=None, strength=None, age_sec=0, outcome=None, strategy=None, reasons=None, valid_for_candle=True, fresh=True, cached=False):
        self.source = source
        self.source_name = source_name
        self.pair = pair
        self.display_pair = display_pair or pair
        self.direction = direction
        self.confidence = confidence
        self.strength = strength
        self.timestamp = timestamp
        self.candle_time = candle_time
        self.age_sec = age_sec
        self.outcome = outcome
        self.strategy = strategy
        self.reasons = reasons
        self.valid_for_candle = valid_for_candle
        self.fresh = fresh
        self.cached = cached


class _FakeCandleConsensus:
    def __init__(self, pair, candle_time, signals=None, fresh_count=0, call_count=0, put_count=0, neutral_count=0, consensus=None, display_pair=None, category="otc"):
        self.pair = pair
        self.display_pair = display_pair or pair
        self.category = category
        self.candle_time = candle_time
        self.signals = signals or []
        self.fresh_count = fresh_count
        self.call_count = call_count
        self.put_count = put_count
        self.neutral_count = neutral_count
        self.consensus = consensus or _FakeConsensus("1-only", None)


class _FakePair:
    def __init__(self, pair, display_pair, category, consensus, signals=None, candles=None, latest_candle=None, fresh_count=0, call_count=0, put_count=0, neutral_count=0):
        self.pair = pair
        self.display_pair = display_pair
        self.category = category
        self.consensus = consensus
        self.signals = signals or []
        self.candles = candles or []
        self.latest_candle = latest_candle
        self.fresh_count = fresh_count
        self.call_count = call_count
        self.put_count = put_count
        self.neutral_count = neutral_count


class _FakeApp:
    def __init__(self, id="app1", name="Test App", url="http://x", online=True, last_checked=0, signal_count=10, fresh_signal_count=5, health="ok", detail="ok", live=True, token_expired=False, latency_ms=42, uptime_sec=99, active_streams=3, raw_count=10, skipped=None, error=None):
        self.id = id
        self.name = name
        self.url = url
        self.online = online
        self.last_checked = last_checked
        self.signal_count = signal_count
        self.fresh_signal_count = fresh_signal_count
        self.health = health
        self.detail = detail
        self.live = live
        self.token_expired = token_expired
        self.latency_ms = latency_ms
        self.uptime_sec = uptime_sec
        self.active_streams = active_streams
        self.raw_count = raw_count
        self.skipped = skipped or {}
        self.error = error


class _FakeSnapshot:
    def __init__(self, pairs, apps, summary=None, timestamp=0, freshness_window_sec=1800):
        self.pairs = pairs
        self.apps = apps
        self.summary = summary or {
            "totalPairs": len(pairs),
            "threeBotAgree": [],
            "twoBotAgree": [],
            "conflicts": [],
            "singleOnly": [],
            "pairsByDirection": {"CALL": 0, "PUT": 0},
        }
        self.timestamp = timestamp
        self.freshness_window_sec = freshness_window_sec


# ---------------------------------------------------------------------------
# get_per_pair_winrate_lookup
# ---------------------------------------------------------------------------


def test_winrate_lookup_returns_empty_for_none():
    assert get_per_pair_winrate_lookup(None) == {}


def test_winrate_lookup_returns_empty_for_empty_result():
    assert get_per_pair_winrate_lookup({"perPair": []}) == {}


def test_winrate_lookup_maps_pair_to_winrate():
    cached = {
        "perPair": [
            {"pair": "USDBDT_otc", "winRate": 52.4, "gradedTotal": 42, "levels": {"3-agree": {"winRate": 60.0}}},
            {"pair": "USDCOP_otc", "winRate": None, "gradedTotal": 0, "levels": {}},
        ]
    }
    out = get_per_pair_winrate_lookup(cached)
    assert set(out.keys()) == {"USDBDT_otc", "USDCOP_otc"}
    assert out["USDBDT_otc"]["winRate"] == 52.4
    assert out["USDBDT_otc"]["gradedTotal"] == 42
    assert out["USDBDT_otc"]["levels"]["3-agree"]["winRate"] == 60.0
    assert out["USDCOP_otc"]["winRate"] is None


# ---------------------------------------------------------------------------
# backtest cache
# ---------------------------------------------------------------------------


def test_backtest_cache_age_is_negative_when_never_run(monkeypatch):
    # Force a fresh cache singleton
    import app.backtest_runner as br
    monkeypatch.setattr(br, "_cache", BacktestCache())
    # REVIEW-1 L57 fix: returns None for "never fetched" instead of -1.0.
    # The dashboard renders None as "—" rather than the literal "cache -1s".
    assert get_backtest_cache_age_sec() is None


def test_backtest_cache_age_returns_elapsed_since_fetched(monkeypatch):
    import time
    import app.backtest_runner as br
    cache = BacktestCache(fetched_at=time.time() - 10.0)
    monkeypatch.setattr(br, "_cache", cache)
    age = get_backtest_cache_age_sec()
    assert 9.0 <= age <= 12.0


def test_get_cached_backtest_returns_none_when_unset(monkeypatch):
    import app.backtest_runner as br
    monkeypatch.setattr(br, "_cache", BacktestCache())
    assert get_cached_backtest() is None


def test_get_cached_backtest_returns_result(monkeypatch):
    import app.backtest_runner as br
    fake = {"verdict": {"kind": "validated"}, "perPair": []}
    monkeypatch.setattr(br, "_cache", BacktestCache(result=fake, fetched_at=0.0))
    assert get_cached_backtest() is fake


@pytest.mark.asyncio
async def test_run_backtest_coordinated_joins_in_flight_refresh(monkeypatch):
    """GET /api/backtest (run_backtest_coordinated) must not start a second
    concurrent run_backtest() when the poller's background refresh
    (get_or_refresh_backtest) is already mid-flight — regression test for a
    race that doubled upstream load and could let a slower-but-earlier run
    clobber a newer cached result."""
    import app.backtest_runner as br
    monkeypatch.setattr(br, "_cache", BacktestCache())

    call_count = 0
    started = asyncio.Event()
    release = asyncio.Event()

    async def fake_run_backtest():
        nonlocal call_count
        call_count += 1
        started.set()
        await release.wait()
        return {"verdict": {"kind": "validated"}, "perPair": [], "run": call_count}

    monkeypatch.setattr(br, "run_backtest", fake_run_backtest)

    # Background refresh, the way a /api/snapshot poll triggers one.
    bg_task = asyncio.create_task(br.get_or_refresh_backtest())
    await asyncio.wait_for(started.wait(), timeout=1)

    # A concurrent manual "Run fresh backtest" should JOIN it, not race it.
    coordinated_task = asyncio.create_task(br.run_backtest_coordinated())
    await asyncio.sleep(0)  # let it schedule and reach _ensure_refresh_task()

    release.set()
    await bg_task
    result = await coordinated_task

    assert call_count == 1
    assert result["run"] == 1


# ---------------------------------------------------------------------------
# _serialize_pair enrichment with win rate
# ---------------------------------------------------------------------------


def test_serialize_pair_includes_winrate_fields():
    from app.api.routes import _serialize_pair
    pair = _FakePair(
        pair="USDBDT_otc",
        display_pair="USD/BDT OTC",
        category="otc",
        consensus=_FakeConsensus("3-agree", "CALL", agreeing=["app1", "app2", "app3"]),
        latest_candle=_FakeCandleConsensus(
            pair="USDBDT_otc",
            candle_time=1700000000,
            signals=[_FakeSignal("app1", "USDBDT_otc", "CALL", 1700000000, 1700000000)],
            consensus=_FakeConsensus("3-agree", "CALL"),
        ),
    )
    winrate_lookup = {"USDBDT_otc": {"winRate": 52.4, "gradedTotal": 42, "levels": {"3-agree": {"winRate": 60.0}}}}
    out = _serialize_pair(pair, winrate_lookup=winrate_lookup)
    assert out["winRate"] == 52.4
    assert out["gradedTotal"] == 42
    assert out["levelStats"]["3-agree"]["winRate"] == 60.0


def test_serialize_pair_without_winrate_returns_none():
    from app.api.routes import _serialize_pair
    pair = _FakePair(
        pair="USDCOP_otc",
        display_pair="USD/COP OTC",
        category="otc",
        consensus=_FakeConsensus("1-only", "PUT"),
    )
    out = _serialize_pair(pair, winrate_lookup={})
    assert out["winRate"] is None
    assert out["gradedTotal"] == 0


# ---------------------------------------------------------------------------
# _serialize_signal enrichment with timing fields
# ---------------------------------------------------------------------------


def test_serialize_signal_includes_emitted_candle_lead():
    from app.api.routes import _serialize_signal
    # Signal emitted 5 seconds BEFORE its candle opened (a prediction)
    sig = _FakeSignal("app1", "USDBDT_otc", "CALL", 1699999995, 1700000000)
    out = _serialize_signal(sig)
    assert out["emittedUtc"] is not None
    assert out["candleUtc"] is not None
    assert out["leadSec"] == 5  # candle - emit


def test_serialize_signal_lead_is_negative_for_during_candle():
    from app.api.routes import _serialize_signal
    sig = _FakeSignal("app1", "USDBDT_otc", "CALL", 1700000030, 1700000000)
    out = _serialize_signal(sig)
    assert out["leadSec"] == -30


def test_serialize_signal_lead_is_none_when_no_timestamp():
    from app.api.routes import _serialize_signal
    sig = _FakeSignal("app1", "USDBDT_otc", "CALL", 0, 1700000000)
    out = _serialize_signal(sig)
    assert out["leadSec"] is None


def test_serialize_signal_sample_lead_is_none_when_no_timestamp():
    """_serialize_signal_sample (used by /api/diag's per-app 'sample' list)
    must guard timestamp==0 exactly like _serialize_signal does — without
    it, lead becomes candle_time - 0 (~1.7 billion seconds), which
    _signal_timing_status then mislabels 'prediction' instead of 'unknown',
    and /api/diag ships a nonsensical multi-billion-second leadSec."""
    from app.api.routes import _serialize_signal_sample
    sig = _FakeSignal("app1", "USDBDT_otc", "CALL", 0, 1700000000)
    out = _serialize_signal_sample(sig, now_sec=1700000010)
    assert out["leadSec"] is None
    assert out["timingStatus"] == "unknown"


# ---------------------------------------------------------------------------
# _signal_timing_status classification
# ---------------------------------------------------------------------------


def test_signal_timing_status_prediction():
    from app.api.routes import _signal_timing_status
    assert _signal_timing_status(30, 0) == "prediction"


def test_signal_timing_status_live():
    from app.api.routes import _signal_timing_status
    assert _signal_timing_status(-30, 0) == "live"


def test_signal_timing_status_lookahead():
    from app.api.routes import _signal_timing_status
    assert _signal_timing_status(-120, 0) == "look-ahead"


def test_signal_timing_status_stale():
    from app.api.routes import _signal_timing_status
    assert _signal_timing_status(-30, 200) == "stale"


# ---------------------------------------------------------------------------
# /api/signal-feed shape
# ---------------------------------------------------------------------------


def test_signal_feed_endpoint_returns_flat_list(monkeypatch):
    """The signal-feed endpoint flattens snapshot.pairs → latest_candle.signals
    into a chronological list with timing info."""
    import app.api.routes as routes
    import app.snapshot_poller as sp

    candle_time = 1700000000
    snapshot = _FakeSnapshot(
        pairs=[
            _FakePair(
                pair="USDBDT_otc",
                display_pair="USD/BDT OTC",
                category="otc",
                consensus=_FakeConsensus("3-agree", "CALL", agreeing=["app1", "app2", "app3"]),
                latest_candle=_FakeCandleConsensus(
                    pair="USDBDT_otc",
                    candle_time=candle_time,
                    signals=[
                        _FakeSignal("app1", "USDBDT_otc", "CALL", candle_time - 5, candle_time),
                        _FakeSignal("app2", "USDBDT_otc", "CALL", candle_time - 3, candle_time),
                    ],
                    consensus=_FakeConsensus("3-agree", "CALL"),
                ),
            ),
        ],
        apps=[_FakeApp()],
    )

    # Stub the snapshot_poller functions AS IMPORTED INSIDE routes.py —
    # routes.py did `from ..snapshot_poller import get_snapshot, ...`, so the
    # names now live in the routes module namespace. Patch there.
    monkeypatch.setattr(routes, "get_snapshot", lambda: {"snapshot": snapshot, "age_ms": 100})
    monkeypatch.setattr(routes, "start_poller", lambda: None)
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop_coro)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: None)
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: -1.0)

    # Use the FastAPI TestClient
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/signal-feed?limit=10")
    assert r.status_code == 200, r.text
    data = r.json()
    assert "items" in data
    assert data["total"] == 2
    assert len(data["items"]) == 2
    item = data["items"][0]
    # Required timing fields
    for k in ("pair", "displayPair", "source", "direction", "emittedAt", "emittedUtc", "candleTime", "candleUtc", "leadSec", "lagSec", "consensusLevel", "consensusDirection"):
        assert k in item, f"missing {k}"
    # Sorted newest-first
    assert data["items"][0]["emittedAt"] >= data["items"][1]["emittedAt"]


# ---------------------------------------------------------------------------
# /api/pairs filters
# ---------------------------------------------------------------------------


def _stub_snapshot(monkeypatch, pairs):
    import app.api.routes as routes
    snapshot = _FakeSnapshot(pairs=pairs, apps=[_FakeApp()])
    monkeypatch.setattr(routes, "get_snapshot", lambda: {"snapshot": snapshot, "age_ms": 100})
    monkeypatch.setattr(routes, "start_poller", lambda: None)
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop_coro)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: None)
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: -1.0)


def test_pairs_endpoint_filters_by_category(monkeypatch):
    _stub_snapshot(monkeypatch, [
        _FakePair("USDBDT_otc", "USD/BDT OTC", "otc", _FakeConsensus("3-agree", "CALL")),
        _FakePair("EURUSD", "EUR/USD", "real", _FakeConsensus("3-agree", "CALL")),
    ])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)
    r = client.get("/api/pairs?category=otc")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["category"] == "otc"


def test_pairs_endpoint_filters_by_level(monkeypatch):
    _stub_snapshot(monkeypatch, [
        _FakePair("USDBDT_otc", "USD/BDT OTC", "otc", _FakeConsensus("3-agree", "CALL")),
        _FakePair("USDCOP_otc", "USD/COP OTC", "otc", _FakeConsensus("1-only", "PUT")),
    ])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)
    r = client.get("/api/pairs?level=3-agree")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["consensus"]["level"] == "3-agree"


def test_pairs_endpoint_filters_by_direction(monkeypatch):
    _stub_snapshot(monkeypatch, [
        _FakePair("USDBDT_otc", "USD/BDT OTC", "otc", _FakeConsensus("3-agree", "CALL")),
        _FakePair("USDCOP_otc", "USD/COP OTC", "otc", _FakeConsensus("3-agree", "PUT")),
    ])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)
    r = client.get("/api/pairs?direction=CALL")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["consensus"]["direction"] == "CALL"


def test_pairs_endpoint_search_by_pair_name(monkeypatch):
    _stub_snapshot(monkeypatch, [
        _FakePair("USDBDT_otc", "USD/BDT OTC", "otc", _FakeConsensus("3-agree", "CALL")),
        _FakePair("USDCOP_otc", "USD/COP OTC", "otc", _FakeConsensus("3-agree", "CALL")),
    ])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)
    r = client.get("/api/pairs?q=BDT")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["pair"] == "USDBDT_otc"


# ---------------------------------------------------------------------------
# /api/backtest/status
# ---------------------------------------------------------------------------


def test_backtest_status_returns_neg_age_when_unset(monkeypatch):
    import app.api.routes as routes
    import app.backtest_runner as br
    monkeypatch.setattr(br, "_cache", BacktestCache())
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: None)
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: -1.0)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)
    r = client.get("/api/backtest/status")
    assert r.status_code == 200
    data = r.json()
    assert data["cacheAgeSec"] == -1.0
    assert data["hasResult"] is False
    assert data["verdict"] is None
    assert data["totalSignals"] == 0


def test_backtest_status_returns_summary_when_cached(monkeypatch):
    import app.api.routes as routes
    import app.backtest_runner as br
    fake = {
        "verdict": {"kind": "validated", "message": "ok"},
        "totalSignals": 1022,
        "totalClusters": 758,
        "perPair": [{"pair": "USDBDT_otc"}],
        "timestamp": 1700000000000,
    }
    monkeypatch.setattr(br, "_cache", BacktestCache(result=fake, fetched_at=1700000000.0))
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: fake)
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: 5.0)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)
    r = client.get("/api/backtest/status")
    data = r.json()
    assert data["cacheAgeSec"] == 5.0
    assert data["hasResult"] is True
    assert data["verdict"]["kind"] == "validated"
    assert data["totalSignals"] == 1022
    assert data["totalClusters"] == 758
    assert data["perPairCount"] == 1


# ---------------------------------------------------------------------------
# New Signals-tab column structure — /api/pairs returns per-app predictions,
# agreeCount, finalPrediction, entryTimeUtc, winRate60Min
# ---------------------------------------------------------------------------


def test_pairs_returns_per_app_predictions_as_columns(monkeypatch):
    """Each pair row must carry app1Prediction, app2Prediction, app3Prediction
    as flat columns (CALL | PUT | None)."""
    candle_time = 1700000000
    pair = _FakePair(
        pair="USDBDT_otc",
        display_pair="USD/BDT OTC",
        category="otc",
        consensus=_FakeConsensus("3-agree", "CALL", agreeing=["app1", "app2", "app3"]),
        latest_candle=_FakeCandleConsensus(
            pair="USDBDT_otc",
            candle_time=candle_time,
            signals=[
                _FakeSignal("app1", "USDBDT_otc", "CALL", candle_time - 5, candle_time),
                _FakeSignal("app2", "USDBDT_otc", "CALL", candle_time - 3, candle_time),
                _FakeSignal("app3", "USDBDT_otc", "CALL", candle_time - 1, candle_time),
            ],
            consensus=_FakeConsensus("3-agree", "CALL"),
        ),
    )
    _stub_snapshot(monkeypatch, [pair])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/pairs")
    assert r.status_code == 200
    item = r.json()["items"][0]
    # New flat columns
    assert item["app1Prediction"] == "CALL"
    assert item["app2Prediction"] == "CALL"
    assert item["app3Prediction"] == "CALL"
    assert item["marketType"] == "otc"
    assert item["agreeCount"] == 3
    assert item["agreeLevel"] == "3-agree"
    assert item["finalPrediction"] == "CALL"
    # Entry time = candle open UTC, formatted as HH:MM
    assert item["entryTimeUtc"] is not None and ":" in item["entryTimeUtc"]
    # Per-app signal details for expandable row
    assert isinstance(item["signals"], list)
    assert len(item["signals"]) == 3


def test_pairs_returns_none_for_missing_app_prediction(monkeypatch):
    """When an app has no signal for the latest candle, its prediction
    column must be None (not '—' or empty string)."""
    candle_time = 1700000000
    pair = _FakePair(
        pair="USDBDT_otc",
        display_pair="USD/BDT OTC",
        category="otc",
        consensus=_FakeConsensus("1-only", "CALL", agreeing=["app1"]),
        latest_candle=_FakeCandleConsensus(
            pair="USDBDT_otc",
            candle_time=candle_time,
            signals=[
                _FakeSignal("app1", "USDBDT_otc", "CALL", candle_time - 5, candle_time),
                # app2 and app3 missing
            ],
            consensus=_FakeConsensus("1-only", "CALL"),
        ),
    )
    _stub_snapshot(monkeypatch, [pair])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/pairs")
    item = r.json()["items"][0]
    assert item["app1Prediction"] == "CALL"
    assert item["app2Prediction"] is None
    assert item["app3Prediction"] is None
    # agreeCount counts how many apps have a signal matching the final dir
    assert item["agreeCount"] == 1


def test_pairs_winrate_60min_is_passed_through_from_backtest(monkeypatch):
    """winRate60Min should come from the cached backtest lookup."""
    candle_time = 1700000000
    pair = _FakePair(
        pair="USDBDT_otc",
        display_pair="USD/BDT OTC",
        category="otc",
        consensus=_FakeConsensus("3-agree", "CALL"),
        latest_candle=_FakeCandleConsensus(
            pair="USDBDT_otc",
            candle_time=candle_time,
            signals=[_FakeSignal("app1", "USDBDT_otc", "CALL", candle_time - 5, candle_time)],
            consensus=_FakeConsensus("3-agree", "CALL"),
        ),
    )
    # Override the stub to also provide a winrate lookup with 60-min data.
    import app.api.routes as routes
    snapshot = _FakeSnapshot(pairs=[pair], apps=[_FakeApp()])
    monkeypatch.setattr(routes, "get_snapshot", lambda: {"snapshot": snapshot, "age_ms": 100})
    monkeypatch.setattr(routes, "start_poller", lambda: None)
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop_coro)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: {"perPair": [
        {"pair": "USDBDT_otc", "winRate": 50.0, "gradedTotal": 40,
         "winRate60Min": 66.7, "gradedTotal60Min": 10, "wins60Min": 6, "losses60Min": 4,
         "levels": {}},
    ]})
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: 5.0)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/pairs")
    item = r.json()["items"][0]
    assert item["winRate60Min"] == 66.7
    assert item["gradedTotal60Min"] == 10
    assert item["wins60Min"] == 6
    assert item["losses60Min"] == 4
    assert item["winRate"] == 50.0


def test_pairs_filters_by_agree_count(monkeypatch):
    """agree_count query param filters pairs with at least N apps agreeing
    with the final direction."""
    candle_time = 1700000000
    pair_3agree = _FakePair(
        pair="USDBDT_otc", display_pair="USD/BDT OTC", category="otc",
        consensus=_FakeConsensus("3-agree", "CALL"),
        latest_candle=_FakeCandleConsensus(
            pair="USDBDT_otc", candle_time=candle_time,
            signals=[
                _FakeSignal("app1", "USDBDT_otc", "CALL", candle_time, candle_time),
                _FakeSignal("app2", "USDBDT_otc", "CALL", candle_time, candle_time),
                _FakeSignal("app3", "USDBDT_otc", "CALL", candle_time, candle_time),
            ],
            consensus=_FakeConsensus("3-agree", "CALL"),
        ),
    )
    pair_1only = _FakePair(
        pair="USDCOP_otc", display_pair="USD/COP OTC", category="otc",
        consensus=_FakeConsensus("1-only", "PUT"),
        latest_candle=_FakeCandleConsensus(
            pair="USDCOP_otc", candle_time=candle_time,
            signals=[
                _FakeSignal("app1", "USDCOP_otc", "PUT", candle_time, candle_time),
                _FakeSignal("app2", "USDCOP_otc", "CALL", candle_time, candle_time),
                _FakeSignal("app3", "USDCOP_otc", "CALL", candle_time, candle_time),
            ],
            consensus=_FakeConsensus("1-only", "PUT"),
        ),
    )
    _stub_snapshot(monkeypatch, [pair_3agree, pair_1only])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    # agree_count=3 should only return the 3-agree pair
    r = client.get("/api/pairs?agree_count=3")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["pair"] == "USDBDT_otc"
    assert items[0]["agreeCount"] == 3


def test_pairs_filters_by_per_app_direction(monkeypatch):
    """app1_dir / app2_dir / app3_dir query params filter by per-app
    prediction."""
    candle_time = 1700000000
    pair_call = _FakePair(
        pair="USDBDT_otc", display_pair="USD/BDT OTC", category="otc",
        consensus=_FakeConsensus("1-only", "CALL"),
        latest_candle=_FakeCandleConsensus(
            pair="USDBDT_otc", candle_time=candle_time,
            signals=[_FakeSignal("app1", "USDBDT_otc", "CALL", candle_time, candle_time)],
            consensus=_FakeConsensus("1-only", "CALL"),
        ),
    )
    pair_put = _FakePair(
        pair="USDCOP_otc", display_pair="USD/COP OTC", category="otc",
        consensus=_FakeConsensus("1-only", "PUT"),
        latest_candle=_FakeCandleConsensus(
            pair="USDCOP_otc", candle_time=candle_time,
            signals=[_FakeSignal("app1", "USDCOP_otc", "PUT", candle_time, candle_time)],
            consensus=_FakeConsensus("1-only", "PUT"),
        ),
    )
    _stub_snapshot(monkeypatch, [pair_call, pair_put])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/pairs?app1_dir=CALL")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["app1Prediction"] == "CALL"


def test_pairs_filters_by_min_winrate_60min(monkeypatch):
    """min_winrate_60min excludes pairs whose 60-min win rate is below the
    threshold (or unknown)."""
    candle_time = 1700000000
    pair_high = _FakePair(
        pair="USDBDT_otc", display_pair="USD/BDT OTC", category="otc",
        consensus=_FakeConsensus("1-only", "CALL"),
        latest_candle=_FakeCandleConsensus(
            pair="USDBDT_otc", candle_time=candle_time,
            signals=[_FakeSignal("app1", "USDBDT_otc", "CALL", candle_time, candle_time)],
            consensus=_FakeConsensus("1-only", "CALL"),
        ),
    )
    pair_low = _FakePair(
        pair="USDCOP_otc", display_pair="USD/COP OTC", category="otc",
        consensus=_FakeConsensus("1-only", "CALL"),
        latest_candle=_FakeCandleConsensus(
            pair="USDCOP_otc", candle_time=candle_time,
            signals=[_FakeSignal("app1", "USDCOP_otc", "CALL", candle_time, candle_time)],
            consensus=_FakeConsensus("1-only", "CALL"),
        ),
    )
    import app.api.routes as routes
    snapshot = _FakeSnapshot(pairs=[pair_high, pair_low], apps=[_FakeApp()])
    monkeypatch.setattr(routes, "get_snapshot", lambda: {"snapshot": snapshot, "age_ms": 100})
    monkeypatch.setattr(routes, "start_poller", lambda: None)
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop_coro)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: {"perPair": [
        {"pair": "USDBDT_otc", "winRate60Min": 70.0, "gradedTotal60Min": 10, "wins60Min": 7, "losses60Min": 3, "levels": {}},
        {"pair": "USDCOP_otc", "winRate60Min": 30.0, "gradedTotal60Min": 10, "wins60Min": 3, "losses60Min": 7, "levels": {}},
    ]})
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: 5.0)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/pairs?min_winrate_60min=50")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["pair"] == "USDBDT_otc"


def test_pairs_sorted_by_agreecount_then_winrate60(monkeypatch):
    """Pairs should be sorted: agreeCount desc, then 60-min win rate desc,
    then by display pair name asc."""
    candle_time = 1700000000
    p_a = _FakePair(
        pair="AAA_otc", display_pair="AAA OTC", category="otc",
        consensus=_FakeConsensus("1-only", "CALL"),
        latest_candle=_FakeCandleConsensus(
            pair="AAA_otc", candle_time=candle_time,
            signals=[_FakeSignal("app1", "AAA_otc", "CALL", candle_time, candle_time)],
            consensus=_FakeConsensus("1-only", "CALL"),
        ),
    )
    p_b = _FakePair(
        pair="BBB_otc", display_pair="BBB OTC", category="otc",
        consensus=_FakeConsensus("3-agree", "CALL"),
        latest_candle=_FakeCandleConsensus(
            pair="BBB_otc", candle_time=candle_time,
            signals=[
                _FakeSignal("app1", "BBB_otc", "CALL", candle_time, candle_time),
                _FakeSignal("app2", "BBB_otc", "CALL", candle_time, candle_time),
                _FakeSignal("app3", "BBB_otc", "CALL", candle_time, candle_time),
            ],
            consensus=_FakeConsensus("3-agree", "CALL"),
        ),
    )
    _stub_snapshot(monkeypatch, [p_a, p_b])
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/pairs")
    items = r.json()["items"]
    # BBB (3-agree) should come first
    assert items[0]["pair"] == "BBB_otc"
    assert items[1]["pair"] == "AAA_otc"


# ---------------------------------------------------------------------------
# 60-minute win rate computation in backtest_runner
# ---------------------------------------------------------------------------


def test_get_per_pair_winrate_lookup_passes_60min_fields(monkeypatch):
    """get_per_pair_winrate_lookup must propagate winRate60Min / gradedTotal60Min
    from the cached backtest result."""
    cached = {
        "perPair": [
            {"pair": "USDBDT_otc", "winRate": 50.0, "gradedTotal": 40,
             "winRate60Min": 66.7, "gradedTotal60Min": 10, "wins60Min": 6, "losses60Min": 4,
             "levels": {}},
        ]
    }
    out = get_per_pair_winrate_lookup(cached)
    assert "USDBDT_otc" in out
    assert out["USDBDT_otc"]["winRate60Min"] == 66.7
    assert out["USDBDT_otc"]["gradedTotal60Min"] == 10
    assert out["USDBDT_otc"]["wins60Min"] == 6
    assert out["USDBDT_otc"]["losses60Min"] == 4
