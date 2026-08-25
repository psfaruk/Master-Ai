"""Tests for the durable signal ledger + the /api/consensus-history endpoint.

Covers the two things the user reported:

1. "App 1/2/3 merge korle signal gulo thik moto save hocche na" — App 3's
   upstream caps history at 500 rows (~41 min), so older 3-agree candles
   silently degraded to 2-agree once App 3 paged them out. The ledger has
   to replay those rows so the merge stays correct.
2. "History te click korle bistarito dekha jai na" — the per-candle rows
   must carry the full per-app breakdown the detail view renders.
"""

from __future__ import annotations

import asyncio
import json
import os
import time

import pytest

from app import backtest_runner as br
from app.app2_cache import CachedSignal
from app.signal_ledger import (
    activate_ledger,
    flush,
    get_signals,
    ledger_stats,
    record_signal,
    reset_ledger_for_tests,
)


# ---------------------------------------------------------------------------
# Ledger unit tests
# ---------------------------------------------------------------------------


def _rec(**kw):
    base = dict(
        source="app1", pair="EURUSD_otc", candle_time=1_700_000_000,
        direction="CALL", first_seen_sec=1_699_999_970,
    )
    base.update(kw)
    return record_signal(**base)


def test_record_and_read_back():
    assert _rec() is True
    rows = get_signals()
    assert len(rows) == 1
    assert rows[0].source == "app1"
    assert rows[0].direction == "CALL"


def test_rejects_invalid_rows():
    assert _rec(source="app9") is False           # unknown source
    assert _rec(direction="NEUTRAL") is False     # not CALL/PUT
    assert _rec(pair="") is False                 # no pair
    assert _rec(candle_time=0) is False           # no candle
    assert get_signals() == []
    assert ledger_stats()["counters"]["skipped"] == 4


def test_reingest_is_idempotent():
    """Re-fetching the same upstream row every minute must not duplicate it."""
    _rec()
    _rec()
    _rec()
    assert len(get_signals()) == 1


def test_first_seen_keeps_earliest():
    """A later re-fetch must not push emission time forward — that would turn
    a genuine prediction into a look-ahead."""
    _rec(first_seen_sec=1_699_999_970)
    _rec(first_seen_sec=1_699_999_999)  # later re-observation
    assert get_signals()[0].first_seen_sec == 1_699_999_970


def test_outcome_upgrades_but_never_downgrades():
    _rec(outcome=None)
    assert get_signals()[0].outcome is None
    _rec(outcome=1)                       # graded later
    assert get_signals()[0].outcome == 1
    _rec(outcome=None)                    # a later ungraded re-fetch
    assert get_signals()[0].outcome == 1  # must NOT reset to None


def test_direction_is_not_overwritten():
    """An app flipping its own call on a closed candle is an upstream data
    problem; the ledger records what was first published."""
    _rec(direction="CALL")
    _rec(direction="PUT")
    assert get_signals()[0].direction == "CALL"


def test_filters_by_source_pair_and_time():
    _rec(source="app1", pair="EURUSD_otc", candle_time=1_700_000_000)
    _rec(source="app3", pair="EURUSD_otc", candle_time=1_700_000_060)
    _rec(source="app3", pair="GBPUSD_otc", candle_time=1_700_000_120)

    assert len(get_signals(sources=["app3"])) == 2
    assert len(get_signals(pair="EURUSD_otc")) == 2
    assert len(get_signals(min_candle_time=1_700_000_060)) == 2


def test_survives_a_restart(tmp_path):
    """The whole point: a Railway redeploy must not reset merged history."""
    path = str(tmp_path / "ledger.json")
    reset_ledger_for_tests()
    activate_ledger(path)
    _rec(source="app3", candle_time=int(time.time()) // 60 * 60)
    flush()
    assert os.path.exists(path)

    # Simulate a fresh process.
    reset_ledger_for_tests()
    assert get_signals() == []
    activate_ledger(path)
    assert len(get_signals()) == 1
    assert ledger_stats()["perSource"]["app3"]["count"] == 1


def test_prunes_past_retention(tmp_path, monkeypatch):
    monkeypatch.setenv("SIGNAL_LEDGER_RETENTION_HOURS", "1")
    path = str(tmp_path / "ledger.json")
    reset_ledger_for_tests()
    activate_ledger(path)
    now = int(time.time()) // 60 * 60
    _rec(candle_time=now)                    # fresh
    _rec(candle_time=now - 3 * 3600, source="app2")  # 3h old, past retention
    flush()

    saved = json.loads(open(path).read())
    assert len(saved) == 1
    assert saved[0]["source"] == "app1"


def test_corrupt_file_is_ignored_not_raised(tmp_path):
    path = str(tmp_path / "ledger.json")
    open(path, "w").write("{ this is not valid json")
    reset_ledger_for_tests()
    activate_ledger(path)          # must not raise
    assert get_signals() == []


# ---------------------------------------------------------------------------
# The actual bug: App 3's 41-minute history cap
# ---------------------------------------------------------------------------


def _run_backtest_with(monkeypatch, *, app1_rows, app3_rows, app2_records):
    async def fake_fetch(url, **kw):
        if "minimum-pair" in url:
            return {"signals": app1_rows}
        if "otclivedata" in url and "share-signals" not in url:
            return {"signals": app3_rows}
        return {"signals": []}

    async def fake_refresh_candles():
        return None

    monkeypatch.setattr(br, "fetch_json_with_timeout", fake_fetch)
    monkeypatch.setattr(br, "refresh_candles", fake_refresh_candles)
    monkeypatch.setattr(br, "grade_signal", lambda *a, **k: (None, "UNKNOWN"))
    monkeypatch.setattr(br, "get_all_cached_app2_signals", lambda: app2_records)
    monkeypatch.setattr(br, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(br, "start_candle_poller", lambda: None)
    for n in ("1", "2", "3"):
        monkeypatch.setenv(f"APP{n}_CANDLE_OFFSET", "0")
    return asyncio.run(br.run_backtest())


def test_ledger_keeps_3agree_after_app3_pages_out(monkeypatch):
    """The regression this whole change exists for.

    Run 1: all three apps report the same 5 candles → 5 × 3-agree.
    Run 2: App 3 has paged those candles out (its 500-row window moved on)
           and returns nothing. Without the ledger those 5 candles collapse
           to 2-agree. With it, they stay 3-agree.
    """
    now = int(time.time())
    base = ((now // 60) - 10) * 60
    pair = "EURUSD_otc"
    times = [base + i * 60 for i in range(5)]

    app1 = [{"pair": pair, "direction": "CALL", "entry_ts": t} for t in times]
    app3 = [{"pair": pair, "direction": "CALL", "ctime": t} for t in times]
    app2 = [
        CachedSignal(
            pair=pair, candle_time=t, signal="CALL", confidence=None,
            strength=None, first_seen_sec=t - 30, captured_at=float((t - 30) * 1000),
            last_tick_age_sec=None, live=False, buyer_pct=0.6, seller_pct=0.4,
        )
        for t in times
    ]

    r1 = _run_backtest_with(monkeypatch, app1_rows=app1, app3_rows=app3, app2_records=app2)
    assert r1["levels"]["3-agree"]["total"] == 5
    assert r1["ledgerBackfilled"] == 0

    # App 3's history window has moved past these candles.
    r2 = _run_backtest_with(monkeypatch, app1_rows=app1, app3_rows=[], app2_records=app2)
    assert r2["levels"]["3-agree"]["total"] == 5, "3-agree collapsed once App 3 paged out"
    assert r2["levels"]["2-agree"]["total"] == 0
    assert r2["ledgerBackfilled"] == 5


def test_live_data_wins_over_ledger(monkeypatch):
    """The ledger fills holes; it must never shadow a live upstream row."""
    now = int(time.time())
    base = ((now // 60) - 5) * 60
    pair = "GBPUSD_otc"

    _run_backtest_with(
        monkeypatch,
        app1_rows=[{"pair": pair, "direction": "CALL", "entry_ts": base}],
        app3_rows=[], app2_records=[],
    )
    r = _run_backtest_with(
        monkeypatch,
        app1_rows=[{"pair": pair, "direction": "CALL", "entry_ts": base}],
        app3_rows=[], app2_records=[],
    )
    # One candle, one app — not duplicated into two clusters by the replay.
    assert r["totalClusters"] == 1
    assert r["ledgerBackfilled"] == 0


# ---------------------------------------------------------------------------
# /api/consensus-history
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


def _seed_backtest(result):
    """Push a synthetic backtest result straight into the cache, stamped
    fresh so get_or_refresh_backtest() serves it instead of hitting the
    network."""
    cache = br._get_cache()
    cache.result = result
    cache.fetched_at = time.time()


def test_consensus_history_filters_by_level(client, monkeypatch):
    now = int(time.time())
    base = (now // 60) * 60

    def cluster(ts, level, direction, outcome, apps, subset):
        return {
            "ts": ts, "level": level, "direction": direction, "outcome": outcome,
            "outcomeLabel": "WIN" if outcome == 1 else "LOSS" if outcome == 0 else "—",
            "agreeing_apps": apps, "app_subset_key": subset,
            "app_directions": {a: direction for a in apps},
            "app_outcomes": {a: outcome for a in apps},
            "appOutcomeLabels": {a: ("WIN" if outcome == 1 else "LOSS" if outcome == 0 else "—") for a in apps},
        }

    _seed_backtest({
        "timestamp": now * 1000,
        "perPair": [{
            "pair": "EURUSD_otc", "displayPair": "EUR/USD OTC", "category": "otc",
            "history": [
                cluster(base - 60, "3-agree", "CALL", 1, ["app1", "app2", "app3"], "app1+app2+app3"),
                cluster(base - 120, "3-agree", "PUT", 0, ["app1", "app2", "app3"], "app1+app2+app3"),
                cluster(base - 180, "2-agree", "CALL", 1, ["app1", "app2"], "app1+app2"),
                cluster(base - 240, "1-only", "CALL", None, ["app1"], "app1"),
            ],
        }],
    })

    r = client.get("/api/consensus-history?level=3-agree&minutes=60")
    assert r.status_code == 200
    d = r.json()
    assert d["total"] == 2
    assert {i["level"] for i in d["items"]} == {"3-agree"}
    assert d["summary"]["wins"] == 1 and d["summary"]["losses"] == 1
    assert d["summary"]["winRate"] == 50.0

    # byLevel is computed BEFORE the level filter so the folder cards stay
    # populated no matter which level is open.
    assert d["byLevel"]["2-agree"]["total"] == 1
    assert d["byLevel"]["1-only"]["total"] == 1

    r2 = client.get("/api/consensus-history?level=2-agree&minutes=60")
    assert r2.json()["total"] == 1


def test_consensus_history_row_carries_detail_payload(client):
    """Each row must be self-sufficient for the expandable detail card."""
    now = int(time.time())
    base = (now // 60) * 60
    _seed_backtest({
        "timestamp": now * 1000,
        "perPair": [{
            "pair": "EURUSD_otc", "displayPair": "EUR/USD OTC", "category": "otc",
            "history": [{
                "ts": base - 60, "level": "3-agree", "direction": "CALL", "outcome": 1,
                "outcomeLabel": "WIN", "agreeing_apps": ["app1", "app2", "app3"],
                "app_subset_key": "app1+app2+app3",
                "app_directions": {"app1": "CALL", "app2": "CALL", "app3": "CALL"},
                "app_outcomes": {"app1": 1, "app2": 1, "app3": 0},
                "appOutcomeLabels": {"app1": "WIN", "app2": "WIN", "app3": "LOSS"},
            }],
        }],
    })
    row = client.get("/api/consensus-history?level=3-agree").json()["items"][0]
    for key in (
        "app_directions", "app_outcomes", "appOutcomeLabels", "agreeing_apps",
        "app_subset_key", "candleUtc", "ageSec", "displayPair", "category",
        "marketResult", "runningWinRate", "runningWins", "runningLosses",
    ):
        assert key in row, f"detail view needs {key}"
    assert row["marketResult"] == "CALL"      # won → market moved its way
    assert row["runningWinRate"] == 100.0


def test_consensus_history_running_win_rate_is_cumulative(client):
    now = int(time.time())
    base = (now // 60) * 60
    outcomes = [1, 1, 0, 1]   # oldest → newest
    _seed_backtest({
        "timestamp": now * 1000,
        "perPair": [{
            "pair": "EURUSD_otc", "displayPair": "EUR/USD OTC", "category": "otc",
            "history": [
                {"ts": base - (len(outcomes) - i) * 60, "level": "3-agree",
                 "direction": "CALL", "outcome": o, "outcomeLabel": "WIN" if o else "LOSS",
                 "agreeing_apps": ["app1", "app2", "app3"], "app_subset_key": "app1+app2+app3",
                 "app_directions": {}, "app_outcomes": {}, "appOutcomeLabels": {}}
                for i, o in enumerate(outcomes)
            ],
        }],
    })
    items = client.get("/api/consensus-history?level=3-agree").json()["items"]
    # Returned newest-first; running rate walks oldest → newest.
    assert [i["runningWinRate"] for i in reversed(items)] == [100.0, 100.0, 66.7, 75.0]


def test_consensus_history_direction_and_graded_filters(client):
    now = int(time.time())
    base = (now // 60) * 60
    _seed_backtest({
        "timestamp": now * 1000,
        "perPair": [{
            "pair": "EURUSD_otc", "displayPair": "EUR/USD OTC", "category": "otc",
            "history": [
                {"ts": base - 60, "level": "3-agree", "direction": "CALL", "outcome": 1,
                 "outcomeLabel": "WIN", "agreeing_apps": ["app1", "app2", "app3"],
                 "app_subset_key": "app1+app2+app3", "app_directions": {},
                 "app_outcomes": {}, "appOutcomeLabels": {}},
                {"ts": base - 120, "level": "3-agree", "direction": "PUT", "outcome": None,
                 "outcomeLabel": "—", "agreeing_apps": ["app1", "app2", "app3"],
                 "app_subset_key": "app1+app2+app3", "app_directions": {},
                 "app_outcomes": {}, "appOutcomeLabels": {}},
            ],
        }],
    })
    assert client.get("/api/consensus-history?level=3-agree&direction=CALL").json()["total"] == 1
    assert client.get("/api/consensus-history?level=3-agree&direction=PUT").json()["total"] == 1
    assert client.get("/api/consensus-history?level=3-agree&graded_only=1").json()["total"] == 1
    assert client.get("/api/consensus-history?level=all").json()["total"] == 2


def test_consensus_history_respects_limit_but_reports_total(client):
    now = int(time.time())
    base = (now // 60) * 60
    _seed_backtest({
        "timestamp": now * 1000,
        "perPair": [{
            "pair": "EURUSD_otc", "displayPair": "EUR/USD OTC", "category": "otc",
            "history": [
                {"ts": base - i * 60, "level": "3-agree", "direction": "CALL", "outcome": 1,
                 "outcomeLabel": "WIN", "agreeing_apps": ["app1", "app2", "app3"],
                 "app_subset_key": "app1+app2+app3", "app_directions": {},
                 "app_outcomes": {}, "appOutcomeLabels": {}}
                for i in range(1, 26)
            ],
        }],
    })
    d = client.get("/api/consensus-history?level=3-agree&limit=10").json()
    assert d["total"] == 25
    assert d["returned"] == 10
    assert len(d["items"]) == 10
    # Newest first.
    assert d["items"][0]["ts"] > d["items"][-1]["ts"]
