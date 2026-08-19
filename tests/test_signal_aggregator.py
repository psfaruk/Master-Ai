"""Integration tests for the aggregator, with the 3 source apps faked.

These reproduce the reported failure — "App 2's signals never show up" —
using payloads shaped the way the real apps differ from each other:
different pair spellings, different timestamp units, and a wall-clock string
rendered in a non-UTC timezone.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Dict

import pytest

from app import app2_cache, signal_aggregator


APP1 = "https://minimum-pair-production.up.railway.app"
APP2 = "https://binary-signals-app-production.up.railway.app"
APP3 = "https://otclivedata.up.railway.app"


def _utc(y, mo, d, h, mi, s=0):
    return int(datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp())


now_sec = int(time.time())
current_candle = (now_sec // 60) * 60
prev_candle = current_candle - 60


def clock_at(candle: int, offset_hours: int) -> str:
    d = datetime.fromtimestamp((candle + offset_hours * 3600), tz=timezone.utc)
    return f"{d.hour:02d}:{d.minute:02d}"


def base_routes() -> Dict[str, Any]:
    return {
        f"{APP1}/api/status": {"quotex_connected": True, "error": None, "active_pairs": ["USD/COP OTC"], "auth_mode": "session_token"},
        f"{APP2}/api/status": {"connected": True, "streams": {"active": [1, 2, 3]}},
        f"{APP3}/api/token-status": {"connected": True, "has_env_token": True, "token_source": "env"},
        f"{APP1}/api/history": [],
        f"{APP2}/api/share-signals": {"timestamp": now_sec * 1000, "rows": []},
        f"{APP3}/api/signals": {"signals": []},
        f"{APP3}/api/share-signals": {"signals": []},
    }


def three_apps_agreeing(direction: str = "CALL") -> Dict[str, Any]:
    r = base_routes()
    r[f"{APP1}/api/history"] = [
        {
            "id": 1,
            "pair": "USD/COP OTC",
            "direction": direction,
            "created_at": current_candle - 8,
            "entry_ts": current_candle,
            "target_close_ts": current_candle + 60,
            "confidence": 0.82,
            "source": "near_support,doji_reversal",
            "entry_price": 4150.5,
            "close_price": None,
            "result": "PENDING",
        },
    ]
    r[f"{APP2}/api/share-signals"] = {
        "timestamp": now_sec,
        "rows": [
            {
                "pair": "USD/COP OTC",
                "signal": direction,
                "type": "OTC",
                "time": clock_at(current_candle, 0),
                "confidence": 78,
                "strength": "strong",
                "last_update": 3,
                "live": True,
                "buyer_pct": 63,
                "seller_pct": 37,
            },
        ],
    }
    r[f"{APP3}/api/share-signals"] = {
        "signals": [
            {
                "asset": "usdcop-otc",
                "signal": direction.lower(),
                "time": current_candle * 1000,  # milliseconds
                "confidence": 0.71,
                "strength": "MEDIUM",
            },
        ],
    }
    return r


def find_pair(res, key: str):
    for p in res.pairs:
        if p.pair == key:
            return p
    raise AssertionError(f"pair {key} not in [{', '.join(p.pair for p in res.pairs)}]")


@pytest.fixture(autouse=True)
def reset_caches():
    """The App 2 history cache is a process-wide singleton that deliberately
    survives requests; clear it so one test's candles can't answer for
    another."""
    app2_cache.reset_app2_cache_for_tests()
    yield
    app2_cache.reset_app2_cache_for_tests()


@pytest.fixture
def fake_routes(monkeypatch):
    """Patch ``fetch_json_with_timeout`` to return canned responses from a
    route table the test controls."""
    state = {"routes": base_routes()}

    async def fake_fetch(url, timeout_sec=None, **kwargs):
        routes = state["routes"]
        # Find the longest matching prefix (so query strings work).
        for key in sorted(routes.keys(), key=len, reverse=True):
            if url.startswith(key):
                body = routes[key]
                if isinstance(body, dict) and "__status" in body:
                    # Caller wanted a non-2xx — let http_fetcher turn that into None.
                    raise RuntimeError(f"HTTP {body['__status']}")
                return body
        return None

    # Patch the symbol imported into the aggregator module.
    monkeypatch.setattr(signal_aggregator, "fetch_json_with_timeout", fake_fetch)
    # Also stop the App 2 cache poller so it doesn't fire off real fetches.
    monkeypatch.setattr(app2_cache, "fetch_json_with_timeout", fake_fetch)
    # Stop the background pollers from spinning up (they would call the real
    # fetch_json_with_timeout via the unpatched import in app2_cache).
    monkeypatch.setattr(app2_cache, "start_app2_cache_poller", lambda: None)
    return state


# ---- cross-app alignment ------------------------------------------------


@pytest.mark.asyncio
async def test_all_three_apps_land_on_one_pair_and_candle(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    res = await signal_aggregator.aggregate_signals(1800)

    assert len(res.pairs) == 1
    p = find_pair(res, "USDCOP_otc")
    assert p.pair == "USDCOP_otc"
    assert p.display_pair == "USD/COP OTC"
    assert p.latest_candle is not None
    assert p.latest_candle.candle_time == current_candle
    assert p.consensus.level == "3-agree"
    assert p.consensus.direction == "CALL"
    assert sorted(p.consensus.agreeing_apps) == ["app1", "app2", "app3"]
    assert p.consensus.missing_apps == []


@pytest.mark.asyncio
async def test_app2_is_present_in_candle_signal_list(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("PUT")
    res = await signal_aggregator.aggregate_signals(1800)

    p = find_pair(res, "USDCOP_otc")
    sources = sorted(s.source for s in p.latest_candle.signals)
    assert sources == ["app1", "app2", "app3"]

    app2 = next(s for s in p.latest_candle.signals if s.source == "app2")
    assert app2.direction == "PUT"
    assert app2.candle_time == current_candle
    assert app2.confidence == pytest.approx(0.78, abs=1e-5)  # 0-100 → 0-1
    assert app2.valid_for_candle is True
    assert app2.strategy == "buyers=63% sellers=37%"


@pytest.mark.asyncio
async def test_app2_in_different_timezone_still_aligns(fake_routes):
    for tz in (-8, -3, 0, 5, 9):
        fake_routes["routes"] = three_apps_agreeing("CALL")
        fake_routes["routes"][f"{APP2}/api/share-signals"]["rows"][0]["time"] = clock_at(current_candle, tz)
        res = await signal_aggregator.aggregate_signals(1800)
        p = find_pair(res, "USDCOP_otc")
        app2 = next((s for s in p.latest_candle.signals if s.source == "app2"), None)
        assert app2 is not None, f"app2 missing for tz={tz}"
        assert app2.candle_time == current_candle, f"tz={tz} landed on wrong candle"


@pytest.mark.asyncio
async def test_app2_last_update_is_age_not_timestamp(fake_routes):
    """Regression: server.py emits ``last_update = round(now - last_tick, 0)``
    which is an age in seconds. Read as a unix timestamp, the signal looked
    ~56 years stale and was dropped as not fresh."""
    fake_routes["routes"] = three_apps_agreeing("CALL")
    fake_routes["routes"][f"{APP2}/api/share-signals"]["rows"][0]["last_update"] = 3

    res = await signal_aggregator.aggregate_signals(1800)
    app2 = next(s for s in find_pair(res, "USDCOP_otc").latest_candle.signals if s.source == "app2")
    assert app2.valid_for_candle is True
    assert app2.fresh is True
    assert app2.age_sec < 120
    assert app2.timestamp == current_candle


@pytest.mark.asyncio
async def test_app2_time_is_candle_being_predicted_no_shift(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    fake_routes["routes"][f"{APP2}/api/share-signals"]["rows"][0]["time"] = clock_at(current_candle, 0)
    res = await signal_aggregator.aggregate_signals(1800)
    app2 = next(s for s in find_pair(res, "USDCOP_otc").latest_candle.signals if s.source == "app2")
    # Lands on the same candle as App 1 and App 3 — no shift.
    assert app2.candle_time == current_candle


@pytest.mark.asyncio
async def test_app2_dead_pair_time_dash_is_skipped(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    fake_routes["routes"][f"{APP2}/api/share-signals"]["rows"].append({
        "pair": "AUDCAD_otc",
        "type": "OTC",
        "time": "—",  # server.py emits this when the pair has no stream
        "signal": "CALL",
        "confidence": 0,
        "strength": "—",
        "last_update": None,
        "live": False,
    })
    res = await signal_aggregator.aggregate_signals(1800)
    # No candle can be known for that row, so it must not invent one.
    assert all(p.pair != "AUDCAD_otc" for p in res.pairs)


@pytest.mark.asyncio
async def test_app3_millisecond_ctime_does_not_hijack_newest_candle(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    fake_routes["routes"][f"{APP3}/api/signals"] = {
        "signals": [
            {
                "asset": "USDCOP_otc",
                "signal": "PUT",
                "ctime": prev_candle * 1000,  # milliseconds
                "confidence": 0.6,
                "result": "correct",
            },
        ],
    }
    res = await signal_aggregator.aggregate_signals(1800)
    p = find_pair(res, "USDCOP_otc")
    assert p.latest_candle.candle_time == current_candle
    assert p.consensus.level == "3-agree"
    older = next((c for c in p.candles if c.candle_time == prev_candle), None)
    assert older is not None
    assert older.signals[0].outcome == "CORRECT"


@pytest.mark.asyncio
async def test_disagreement_is_conflict(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    fake_routes["routes"][f"{APP2}/api/share-signals"]["rows"][0]["signal"] = "PUT"
    res = await signal_aggregator.aggregate_signals(1800)
    p = find_pair(res, "USDCOP_otc")
    assert p.consensus.level == "conflict"
    assert "app2" in p.consensus.disagreeing_apps


@pytest.mark.asyncio
async def test_signals_for_different_candles_never_form_consensus(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    fake_routes["routes"][f"{APP1}/api/history"][0]["entry_ts"] = current_candle + 60
    fake_routes["routes"][f"{APP1}/api/history"][0]["created_at"] = current_candle + 55

    res = await signal_aggregator.aggregate_signals(1800)
    p = find_pair(res, "USDCOP_otc")
    ahead = next(c for c in p.candles if c.candle_time == current_candle + 60)
    assert ahead.consensus.level == "1-only"
    assert [s.source for s in ahead.signals] == ["app1"]

    current = next(c for c in p.candles if c.candle_time == current_candle)
    assert current.consensus.level == "2-agree"
    assert sorted(s.source for s in current.signals) == ["app2", "app3"]


# ---- candle history -----------------------------------------------------


@pytest.mark.asyncio
async def test_older_candles_keep_their_consensus(fake_routes):
    fake_routes["routes"] = base_routes()
    old_candle = current_candle - 20 * 60
    fake_routes["routes"][f"{APP1}/api/history"] = [
        {"pair": "EUR/USD OTC", "direction": "CALL", "created_at": old_candle - 5, "entry_ts": old_candle, "confidence": 0.7, "result": "WIN", "source": "microstructure"},
    ]
    fake_routes["routes"][f"{APP3}/api/signals"] = {
        "signals": [{"asset": "EURUSD_otc", "signal": "CALL", "ctime": old_candle, "result": "correct"}],
    }

    res = await signal_aggregator.aggregate_signals(600)  # freshness shorter than age
    p = find_pair(res, "EURUSD_otc")
    old = next(c for c in p.candles if c.candle_time == old_candle)
    assert len(old.signals) == 2
    assert old.consensus.level == "2-agree"
    assert old.consensus.direction == "CALL"


@pytest.mark.asyncio
async def test_signal_emitted_after_candle_closed_does_not_count(fake_routes):
    fake_routes["routes"] = base_routes()
    fake_routes["routes"][f"{APP1}/api/history"] = [
        {
            "pair": "GBP/JPY OTC",
            "direction": "CALL",
            "created_at": current_candle + 600,  # 10 minutes after candle close
            "entry_ts": current_candle,
            "confidence": 0.55,
            "result": "PENDING",
            "source": "microstructure",
        },
    ]
    res = await signal_aggregator.aggregate_signals(1800)
    c = find_pair(res, "GBPJPY_otc").latest_candle
    assert len(c.signals) == 0
    assert c.consensus.level == "none"
    assert "app1" in c.consensus.invalid_apps


# ---- upstream robustness ------------------------------------------------


@pytest.mark.asyncio
async def test_renamed_response_envelope_still_yields_signals(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    app2 = fake_routes["routes"][f"{APP2}/api/share-signals"]
    fake_routes["routes"][f"{APP2}/api/share-signals"] = {
        "timestamp": app2["timestamp"],
        "signals": app2["rows"],  # renamed envelope
    }
    res = await signal_aggregator.aggregate_signals(1800)
    assert find_pair(res, "USDCOP_otc").consensus.level == "3-agree"


@pytest.mark.asyncio
async def test_neutral_rows_are_ignored(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    fake_routes["routes"][f"{APP2}/api/share-signals"]["rows"][0]["signal"] = "NEUTRAL"
    res = await signal_aggregator.aggregate_signals(1800)
    p = find_pair(res, "USDCOP_otc")
    assert p.consensus.level == "2-agree"
    assert sorted(p.consensus.agreeing_apps) == ["app1", "app3"]
    assert "app2" in p.consensus.missing_apps


@pytest.mark.asyncio
async def test_one_app_down_does_not_hide_others(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    fake_routes["routes"][f"{APP1}/api/history"] = {"__status": 503}
    fake_routes["routes"][f"{APP1}/api/status"] = {"__status": 503}

    res = await signal_aggregator.aggregate_signals(1800)
    p = find_pair(res, "USDCOP_otc")
    assert p.consensus.level == "2-agree"
    assert sorted(p.consensus.agreeing_apps) == ["app2", "app3"]
    assert p.consensus.missing_apps == ["app1"]

    app1 = next(a for a in res.apps if a.id == "app1")
    assert app1.health == "down"
    assert app1.online is False


@pytest.mark.asyncio
async def test_app2_keeps_serving_cached_candles_when_live_fails(fake_routes):
    """First poll succeeds and records the current candle; then App 2 goes
    down. Its signal must still appear, flagged as cached."""
    fake_routes["routes"] = three_apps_agreeing("CALL")
    await signal_aggregator.aggregate_signals(1800)

    # App 2's live endpoint goes 502.
    fake_routes["routes"][f"{APP2}/api/share-signals"] = {"__status": 502}
    res = await signal_aggregator.aggregate_signals(1800)

    app2 = next(
        (s for s in find_pair(res, "USDCOP_otc").latest_candle.signals if s.source == "app2"),
        None,
    )
    assert app2 is not None
    assert app2.cached is True
    assert app2.direction == "CALL"


@pytest.mark.asyncio
async def test_app_statuses_report_row_counts(fake_routes):
    fake_routes["routes"] = three_apps_agreeing("CALL")
    res = await signal_aggregator.aggregate_signals(1800)
    by_id = {a.id: a for a in res.apps}

    assert by_id["app1"].health == "ok"
    assert by_id["app2"].health == "ok"
    assert by_id["app3"].health == "ok"
    assert by_id["app2"].raw_count == 1
    assert by_id["app2"].signal_count >= 1
    assert by_id["app2"].active_streams == 3
