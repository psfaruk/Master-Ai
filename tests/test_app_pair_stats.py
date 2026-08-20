"""Tests for per-pair × per-app-subset win rate.

Verifies that:
- _classify_cluster records the actual list of agreeing apps + the
  canonical subset key (e.g. "app1+app2"), not just a count.
- run_backtest propagates appPairStats into each perPair entry, with
  zeroed entries for any subset that didn't occur.
- _build_app_pair_leaders returns the top-N pairs per app subset with
  a minimum graded-sample gate.
- get_per_pair_winrate_lookup surfaces appPairStats.
- /api/pair/{pair} and /api/pairs include appPairStats.
- /api/app-pair-leaders returns both leaders + global aggregates.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import patch

import pytest

from app.backtest_runner import (
    APP_SUBSET_KEYS,
    AppPairStat,
    ClassifiedCluster,
    NormalizedSignal,
    PairStat,
    _build_app_pair_leaders,
    _classify_cluster,
    _serialize_app_pair_stats,
    get_per_pair_winrate_lookup,
    run_backtest,
)


# ---------------------------------------------------------------------------
# _classify_cluster — agreeing_apps + app_subset_key
# ---------------------------------------------------------------------------


def _mk_signal(source: str, direction: str, candle_time: int, outcome=None) -> NormalizedSignal:
    return NormalizedSignal(
        source=source,
        pair="TESTPAIR_otc",
        ts=candle_time - 60,
        candle_time=candle_time,
        direction=direction,
        outcome=outcome,
        raw_status=None,
    )


def test_classify_cluster_2_agree_app1_app2():
    """app1+app2 agree on CALL → level=2-agree, app_subset_key='app1+app2'."""
    apps = {
        "app1": _mk_signal("app1", "CALL", 1000),
        "app2": _mk_signal("app2", "CALL", 1000),
    }
    out = _classify_cluster(apps, 1000)
    assert out["level"] == "2-agree"
    assert out["direction"] == "CALL"
    assert out["agreeing_apps"] == ["app1", "app2"]
    assert out["app_subset_key"] == "app1+app2"


def test_classify_cluster_2_agree_app1_app3():
    """app1+app3 agree on PUT → app_subset_key='app1+app3' (distinct from app1+app2)."""
    apps = {
        "app1": _mk_signal("app1", "PUT", 1000),
        "app3": _mk_signal("app3", "PUT", 1000),
    }
    out = _classify_cluster(apps, 1000)
    assert out["level"] == "2-agree"
    assert out["app_subset_key"] == "app1+app3"


def test_classify_cluster_2_agree_app2_app3():
    """app2+app3 agree → app_subset_key='app2+app3'."""
    apps = {
        "app2": _mk_signal("app2", "CALL", 1000),
        "app3": _mk_signal("app3", "CALL", 1000),
    }
    out = _classify_cluster(apps, 1000)
    assert out["level"] == "2-agree"
    assert out["app_subset_key"] == "app2+app3"


def test_classify_cluster_3_agree():
    """All three apps agree → app_subset_key='app1+app2+app3'."""
    apps = {
        "app1": _mk_signal("app1", "PUT", 1000),
        "app2": _mk_signal("app2", "PUT", 1000),
        "app3": _mk_signal("app3", "PUT", 1000),
    }
    out = _classify_cluster(apps, 1000)
    assert out["level"] == "3-agree"
    assert out["app_subset_key"] == "app1+app2+app3"


def test_classify_cluster_1_only_singleton_subset():
    """Only one app → level=1-only, app_subset_key='app1' (the singleton)."""
    apps = {"app1": _mk_signal("app1", "CALL", 1000)}
    out = _classify_cluster(apps, 1000)
    assert out["level"] == "1-only"
    assert out["app_subset_key"] == "app1"


def test_classify_cluster_conflict_majority_subset():
    """Conflict with majority app1+app2 vs app3 — gradable now follows
    the consensus direction (CALL), so app_subset_key is ``app1+app2``.

    Previously this was deliberately empty (no agreement = no subset
    attribution). REVIEW-1 H4 changed that: a conflict with a clear
    majority (2-1) has a real consensus direction — the majority's apps
    won/lost together, and the per-app-pair stats should attribute the
    outcome to that subset. This matches how `_classify_candle` in the
    aggregator treats conflict-with-majority.
    """
    apps = {
        "app1": _mk_signal("app1", "CALL", 1000),
        "app2": _mk_signal("app2", "CALL", 1000),
        "app3": _mk_signal("app3", "PUT", 1000),
    }
    out = _classify_cluster(apps, 1000)
    assert out["level"] == "conflict"
    # direction is CALL (majority) — gradable follows the majority direction.
    assert out["direction"] == "CALL"
    assert out["agreeing_apps"] == ["app1", "app2"]
    assert out["app_subset_key"] == "app1+app2"


def test_classify_cluster_conflict_tie_no_subset():
    """Pure 1-1 tie → no clear majority, app_subset_key is empty."""
    apps = {
        "app1": _mk_signal("app1", "CALL", 1000),
        "app2": _mk_signal("app2", "PUT", 1000),
    }
    out = _classify_cluster(apps, 1000)
    assert out["level"] == "conflict"
    # direction is None (tie), so agreeing_apps is [] and key is ""
    assert out["direction"] is None
    assert out["app_subset_key"] == ""


# ---------------------------------------------------------------------------
# _serialize_app_pair_stats — full grid always emitted
# ---------------------------------------------------------------------------


def test_serialize_app_pair_stats_emits_all_canonical_keys():
    """Even if only app1+app2 occurred, the serialized output should include
    ALL canonical subset keys (with zeroed stats for unseen ones)."""
    stats = {
        "app1+app2": AppPairStat(total=5, win=4, loss=1),
    }
    out = _serialize_app_pair_stats(stats)
    assert set(APP_SUBSET_KEYS).issubset(set(out.keys()))
    # The one that occurred has the real numbers.
    assert out["app1+app2"]["total"] == 5
    assert out["app1+app2"]["win"] == 4
    assert out["app1+app2"]["loss"] == 1
    assert out["app1+app2"]["winRate"] == 80.0
    # The ones that didn't occur are zeroed with winRate=None.
    assert out["app1+app3"]["total"] == 0
    assert out["app1+app3"]["winRate"] is None
    assert out["app2+app3"]["winRate"] is None
    assert out["app1+app2+app3"]["winRate"] is None


# ---------------------------------------------------------------------------
# _build_app_pair_leaders — top-N + min-sample gate
# ---------------------------------------------------------------------------


def _mk_pair(pair: str, app_pair_key: str, win: int, loss: int) -> PairStat:
    """Build a PairStat with just one app-subset populated."""
    return PairStat(
        pair=pair,
        display_pair=pair.replace("_otc", ""),
        category="otc" if pair.endswith("_otc") else "real",
        levels={"3-agree": AppPairStat(), "2-agree": AppPairStat(), "conflict": AppPairStat(), "1-only": AppPairStat()},
        history=[],
        app_pair_stats={app_pair_key: AppPairStat(total=win + loss, win=win, loss=loss)},
    )


def test_build_app_pair_leaders_min_sample_gate():
    """Pairs with < LEADERBOARD_MIN_GRADED samples are excluded from the leaderboard."""
    # LEADERBOARD_MIN_GRADED = 3
    per_pair = [
        _mk_pair("EURUSD_otc", "app1+app2", win=8, loss=1),  # 9 graded — qualifies
        _mk_pair("GBPUSD_otc", "app1+app2", win=2, loss=0),  # 2 graded — excluded
        _mk_pair("USDJPY_otc", "app1+app2", win=5, loss=4),  # 9 graded — qualifies, lower WR
    ]
    out = _build_app_pair_leaders(per_pair)
    assert "app1+app2" in out
    # Only 2 of 3 qualify.
    assert len(out["app1+app2"]) == 2
    # Top by win rate desc. winRate is rounded to 1 decimal.
    assert out["app1+app2"][0]["pair"] == "EURUSD_otc"
    assert out["app1+app2"][0]["winRate"] == round((8 / 9) * 100, 1)
    assert out["app1+app2"][1]["pair"] == "USDJPY_otc"
    assert out["app1+app2"][1]["winRate"] == round((5 / 9) * 100, 1)
    # Other app-subset keys have empty leaderboards.
    assert out["app1+app3"] == []
    assert out["app2+app3"] == []
    assert out["app1+app2+app3"] == []


def test_build_app_pair_leaders_top_n_cap():
    """Leaderboard caps at LEADERBOARD_TOP_N (10)."""
    per_pair = [_mk_pair(f"PAIR{i}_otc", "app1+app2", win=10, loss=0) for i in range(20)]
    out = _build_app_pair_leaders(per_pair)
    assert len(out["app1+app2"]) == 10


def test_build_app_pair_leaders_isolates_app_subsets():
    """app1+app2 leaderboard doesn't bleed into app1+app3."""
    per_pair = [
        _mk_pair("EURUSD_otc", "app1+app2", win=8, loss=1),
        _mk_pair("EURUSD_otc", "app1+app3", win=2, loss=8),  # same pair, different subset
    ]
    # NOTE: the two PairStats above are for the same pair — _build_app_pair_leaders
    # sees them as separate pairs in the per_pair list. In reality run_backtest
    # merges them into a single PairStat with both subsets populated. Test that
    # merging behavior separately (see test_run_backtest_per_pair_app_pair_merge).
    out = _build_app_pair_leaders(per_pair)
    assert len(out["app1+app2"]) == 1
    assert out["app1+app2"][0]["winRate"] == round((8 / 9) * 100, 1)
    assert len(out["app1+app3"]) == 1
    assert out["app1+app3"][0]["winRate"] == round((2 / 10) * 100, 1)


# ---------------------------------------------------------------------------
# get_per_pair_winrate_lookup — appPairStats pass-through
# ---------------------------------------------------------------------------


def test_per_pair_winrate_lookup_includes_app_pair_stats():
    cached = {
        "perPair": [
            {
                "pair": "EURUSD_otc",
                "winRate": 60.0,
                "gradedTotal": 10,
                "levels": {},
                "winRate60Min": 55.0,
                "gradedTotal60Min": 4,
                "wins60Min": 3,
                "losses60Min": 1,
                "appPairStats": {
                    "app1+app2": {"total": 5, "win": 4, "loss": 1, "winRate": 80.0},
                    "app1+app3": {"total": 5, "win": 2, "loss": 3, "winRate": 40.0},
                },
            },
        ]
    }
    out = get_per_pair_winrate_lookup(cached)
    assert "EURUSD_otc" in out
    assert out["EURUSD_otc"]["appPairStats"]["app1+app2"]["winRate"] == 80.0
    assert out["EURUSD_otc"]["appPairStats"]["app1+app3"]["winRate"] == 40.0


def test_per_pair_winrate_lookup_handles_missing_app_pair_stats():
    """Older cached backtest results (pre-this-feature) shouldn't crash the lookup."""
    cached = {
        "perPair": [
            {
                "pair": "EURUSD_otc",
                "winRate": 60.0,
                "gradedTotal": 10,
                "levels": {},
                "winRate60Min": None,
                "gradedTotal60Min": 0,
                "wins60Min": 0,
                "losses60Min": 0,
                # NO appPairStats field
            },
        ]
    }
    out = get_per_pair_winrate_lookup(cached)
    assert out["EURUSD_otc"]["appPairStats"] == {}


# ---------------------------------------------------------------------------
# run_backtest — integration: real (mocked) end-to-end backtest
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_app_signals():
    """Build a deterministic set of 3-app signals for backtesting.

    Layout (all on the SAME pair EURUSD_otc, candle_time=1000..1010):
      - candle 1000: app1+app2 CALL (both win)  → app1+app2, win
      - candle 1060: app1+app3 PUT  (both win)  → app1+app3, win
      - candle 1120: app2+app3 CALL (both lose) → app2+app3, loss
      - candle 1180: app1 CALL only (win)        → app1, win
      - candle 1240: app1+app2+app3 PUT (win)    → all-3, win
    """
    base = 1000
    sigs = []
    # candle 1000: app1+app2 CALL win
    sigs.append(("app1", base + 0, "CALL", 1))
    sigs.append(("app2", base + 0, "CALL", 1))
    # candle 1060: app1+app3 PUT win
    sigs.append(("app1", base + 60, "PUT", 1))
    sigs.append(("app3", base + 60, "PUT", 1))
    # candle 1120: app2+app3 CALL loss
    sigs.append(("app2", base + 120, "CALL", 0))
    sigs.append(("app3", base + 120, "CALL", 0))
    # candle 1180: app1 CALL only win
    sigs.append(("app1", base + 180, "CALL", 1))
    # candle 1240: all-3 PUT win
    sigs.append(("app1", base + 240, "PUT", 1))
    sigs.append(("app2", base + 240, "PUT", 1))
    sigs.append(("app3", base + 240, "PUT", 1))
    return sigs


def _make_normalized(source, candle_time, direction, outcome):
    return NormalizedSignal(
        source=source,
        pair="EURUSD_otc",
        ts=candle_time - 60,
        candle_time=candle_time,
        direction=direction,
        outcome=outcome,
        raw_status=None,
    )


def test_run_backtest_app_pair_stats_end_to_end(monkeypatch, fake_app_signals):
    """End-to-end: backtest produces per-pair appPairStats that correctly
    bucket each cluster into its specific app subset.

    Mocks the upstream fetchers so the backtest operates on a deterministic
    set of 3-app signals.
    """
    import time as _time
    now = int(_time.time())
    # Use candle times within the last 60 minutes so the 6h lookback keeps them.
    base = ((now // 60) - 5) * 60  # 5 minutes ago, minute-floored
    # Re-map the 10 fake signals onto 5 distinct candle times, respecting
    # the original clustering (pairs on the same candle stay together):
    #   candle 0: signals 0,1   (app1+app2 CALL win)
    #   candle 1: signals 2,3   (app1+app3 PUT win)
    #   candle 2: signals 4,5   (app2+app3 CALL loss)
    #   candle 3: signal  6     (app1 CALL only, win)
    #   candle 4: signals 7,8,9 (app1+app2+app3 PUT win)
    candle_times = [base + i * 60 for i in range(5)]
    candle_map = {0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 2, 6: 3, 7: 4, 8: 4, 9: 4}
    remapped_signals = []
    for i, (src, _old_ct, dr, oc) in enumerate(fake_app_signals):
        new_ct = candle_times[candle_map[i]]
        remapped_signals.append((src, new_ct, dr, oc))
    # Mock the upstream fetchers.
    async def fake_fetch(url, **kw):
        # The backtest calls fetch_json_with_timeout for SOURCES["app1"],
        # SOURCES["app3"], SOURCES["app3_live"]. Return empty for all —
        # we'll inject signals directly via the app2 cache.
        return {"signals": []}

    # Mock candle_fetcher.refresh_candles to a no-op.
    async def fake_refresh_candles():
        return None

    # Mock grade_signal to return the outcome already set on each signal.
    # (We pre-set outcomes on every NormalizedSignal so the candle-grading
    # step is a no-op.)
    def fake_grade_signal(pair, candle_time, direction):
        return (None, "UNKNOWN")

    # Mock app2_cache.get_all_cached_app2_signals to return our signals as
    # app2 records.
    from app.app2_cache import CachedSignal
    app2_records = [
        CachedSignal(
            pair="EURUSD_otc", candle_time=ct, signal=dr,
            confidence=None, strength=None,
            first_seen_sec=ct - 60, captured_at=float((ct - 60) * 1000),
            last_tick_age_sec=None, live=False,
            buyer_pct=0.5, seller_pct=0.5,
        )
        for (src, ct, dr, oc) in remapped_signals if src == "app2"
    ]

    # Build a combined set of all signals: app1 and app3 come from the
    # mocked fetcher, app2 from the cache. To simplify, let's inject ALL
    # signals via a fake fetcher that returns them under "app1" / "app2" /
    # "app3" source buckets and bypass canonical_pair by using known
    # canonical keys.
    # However, the backtest's normalize_app1 / normalize_app3 functions
    # expect specific shapes. Easier: monkeypatch normalize_app1 etc.
    # directly to return our NormalizedSignal objects.

    from app import backtest_runner

    # Map source-app → list of NormalizedSignal
    normalized_signals = [
        _make_normalized(src, ct, dr, oc) for (src, ct, dr, oc) in remapped_signals
    ]

    # Intercept _grade_with_candles so app2 signals (which start with
    # outcome=None) get their outcome filled in via our mocked grade_signal.
    # We look up the expected outcome from our remapped_signals by (pair, ct).
    expected_outcomes = {(s[1], s[3]) for s in remapped_signals}  # set of (ct, outcome)

    def fake_grade_with_candles(sigs):
        for s in sigs:
            if s.outcome is not None:
                continue
            if s.raw_status and (s.raw_status.lower() in ("draw", "void")):
                continue
            # Look up the expected outcome for this (pair, candle_time).
            # We match by pair+candle_time (the source doesn't matter — all
            # apps sharing a candle should have the same outcome in our test).
            for (src, ct, dr, oc) in remapped_signals:
                if ct == s.candle_time and src == s.source:
                    if oc == 1:
                        s.outcome = 1
                    elif oc == 0:
                        s.outcome = 0
                    break

    monkeypatch.setattr(backtest_runner, "_grade_with_candles", fake_grade_with_candles)
    # Intercept the upstream fetchers + app2 cache + candle refresh.
    monkeypatch.setattr(backtest_runner, "fetch_json_with_timeout", fake_fetch)
    monkeypatch.setattr(backtest_runner, "refresh_candles", fake_refresh_candles)
    monkeypatch.setattr(backtest_runner, "grade_signal", fake_grade_signal)
    monkeypatch.setattr(backtest_runner, "get_all_cached_app2_signals", lambda: app2_records)

    # But we still need app1 and app3 signals to flow in. The backtest
    # reads them via pick_array(d, [...]) inside run_backtest. Let's
    # intercept at the run_backtest level by injecting them via app2_cache.
    # That puts ALL signals under source="app2", which doesn't give us
    # multi-app agreement.

    # Simpler approach: monkeypatch run_backtest to skip fetching entirely
    # and run the classification on our pre-built signals.
    # We'll do this by monkeypatching normalize_app1 / normalize_app3 to
    # return our pre-built signals keyed by candle_time.

    by_pair = {}
    for s in normalized_signals:
        # Build raw dicts the normalizers can consume.
        pass  # too fiddly — take a different approach below.

    # Direct approach: call run_backtest but with mocked fetch that returns
    # signals matching the expected normalizer input shape.
    app1_signals_raw = [
        {"pair": "EURUSD_otc", "direction": dr, "entry_ts": ct, "result": "WIN" if oc == 1 else "LOSS"}
        for (src, ct, dr, oc) in remapped_signals if src == "app1"
    ]
    app3_signals_raw = [
        {"pair": "EURUSD_otc", "direction": dr, "ctime": ct, "result": "correct" if oc == 1 else "wrong"}
        for (src, ct, dr, oc) in remapped_signals if src == "app3"
    ]

    async def fake_fetch_v2(url, **kw):
        if "minimum-pair" in url:
            return {"signals": app1_signals_raw}
        if "otclivedata" in url and "share-signals" not in url:
            return {"signals": app3_signals_raw}
        return {"signals": []}

    monkeypatch.setattr(backtest_runner, "fetch_json_with_timeout", fake_fetch_v2)
    # And mock candle-fetcher grading so app2 outcomes (None) get filled
    # from our deterministic outcomes.
    candle_outcomes = {(s.pair, s.candle_time): s.outcome for s in normalized_signals if s.source == "app2"}
    sig_lookup = {(s.source, s.candle_time): s for s in normalized_signals}

    def fake_grade_signal_v2(pair, candle_time, direction):
        # Look up the app2 signal for this pair+candle and return its outcome.
        outcome = candle_outcomes.get((pair, candle_time))
        if outcome is None:
            return (None, "UNKNOWN")
        return (None, "WIN" if outcome == 1 else "LOSS")

    monkeypatch.setattr(backtest_runner, "grade_signal", fake_grade_signal_v2)

    # Set candle offset to 0 so candle_time matches what we put in.
    monkeypatch.setenv("APP1_CANDLE_OFFSET", "0")
    monkeypatch.setenv("APP2_CANDLE_OFFSET", "0")
    monkeypatch.setenv("APP3_CANDLE_OFFSET", "0")

    result = asyncio.run(run_backtest())

    # The backtest should have at least one pair.
    assert result["totalClusters"] > 0, f"Expected clusters, got {result['totalClusters']}"
    assert len(result["perPair"]) > 0, "Expected at least one pair"

    # Find our EURUSD_otc pair.
    eur = next((p for p in result["perPair"] if p["pair"] == "EURUSD_otc"), None)
    assert eur is not None, "Expected EURUSD_otc pair in backtest output"

    # Verify appPairStats has all canonical keys.
    aps = eur["appPairStats"]
    for key in APP_SUBSET_KEYS:
        assert key in aps, f"Missing canonical subset key {key!r}"

    # Verify specific app-subset stats match our injected signals.
    # We have:
    #   app1+app2: 1 cluster (candle 1000), 1 win
    #   app1+app3: 1 cluster (candle 1060), 1 win
    #   app2+app3: 1 cluster (candle 1120), 1 loss
    #   app1: 1 cluster (candle 1180), 1 win
    #   app1+app2+app3: 1 cluster (candle 1240), 1 win
    assert aps["app1+app2"]["win"] == 1, f"app1+app2 wins: {aps['app1+app2']}"
    assert aps["app1+app2"]["loss"] == 0
    assert aps["app1+app2"]["winRate"] == 100.0

    assert aps["app1+app3"]["win"] == 1
    assert aps["app1+app3"]["loss"] == 0
    assert aps["app1+app3"]["winRate"] == 100.0

    assert aps["app2+app3"]["win"] == 0
    assert aps["app2+app3"]["loss"] == 1
    assert aps["app2+app3"]["winRate"] == 0.0

    assert aps["app1"]["win"] == 1
    assert aps["app1"]["loss"] == 0

    assert aps["app1+app2+app3"]["win"] == 1
    assert aps["app1+app2+app3"]["loss"] == 0
    assert aps["app1+app2+app3"]["winRate"] == 100.0

    # The top-level appPairLeaders should also be populated. EURUSD has only
    # 1 graded signal per app-subset in this test, which is below the
    # LEADERBOARD_MIN_GRADED=3 threshold — so the leaderboards will be empty
    # for all subsets. That's expected behavior (covered by the dedicated
    # test_build_app_pair_leaders_min_sample_gate test). We just verify the
    # structure here, not the contents.
    leaders = result["appPairLeaders"]
    assert "app1+app2" in leaders
    assert isinstance(leaders["app1+app2"], list)
    # With only 1 graded signal per subset, no pair meets the 3-graded gate.
    assert leaders["app1+app2"] == []
    assert leaders["app1+app3"] == []
    assert leaders["app2+app3"] == []
    assert leaders["app1+app2+app3"] == []


# ---------------------------------------------------------------------------
# /api/app-pair/{subset}/pairs  — full per-subset pair list endpoint
# ---------------------------------------------------------------------------


def test_app_pair_subset_pairs_endpoint_returns_all_pairs(monkeypatch):
    """GET /api/app-pair/app1+app2/pairs returns every pair that has
    signals in the app1+app2 subset, with per-pair signal count + W/L +
    win rate, plus a global aggregate for that subset.

    Differs from /api/app-pair-leaders in that:
      - leaders returns top-10 per subset; this returns ALL pairs
      - leaders requires LEADERBOARD_MIN_GRADED=3 samples; this returns
        every pair with ≥1 signal so the user can see the full
        distribution.
    """
    # Build a cached backtest with 3 pairs, each contributing to app1+app2
    # with different win rates so we can verify sorting.
    cached_backtest = {
        "verdict": {"kind": "validated", "message": "ok"},
        "perPair": [
            {
                "pair": "EURUSD_otc",
                "displayPair": "EUR/USD OTC",
                "category": "otc",
                "appPairStats": {
                    "app1+app2": {"total": 5, "win": 4, "loss": 1, "draw": 0, "unknown": 0,
                                  "call": 3, "put": 2, "callWin": 3, "callLoss": 0,
                                  "putWin": 1, "putLoss": 1, "winRate": 80.0},
                    "app1+app3": {"total": 0, "win": 0, "loss": 0, "draw": 0, "unknown": 0,
                                  "call": 0, "put": 0, "callWin": 0, "callLoss": 0,
                                  "putWin": 0, "putLoss": 0, "winRate": None},
                },
                "levels": {},
            },
            {
                "pair": "GBPJPY_otc",
                "displayPair": "GBP/JPY OTC",
                "category": "otc",
                "appPairStats": {
                    "app1+app2": {"total": 10, "win": 7, "loss": 3, "draw": 0, "unknown": 0,
                                  "call": 5, "put": 5, "callWin": 4, "callLoss": 1,
                                  "putWin": 3, "putLoss": 2, "winRate": 70.0},
                },
                "levels": {},
            },
            {
                "pair": "AUDCAD_otc",
                "displayPair": "AUD/CAD OTC",
                "category": "otc",
                "appPairStats": {
                    "app1+app2": {"total": 3, "win": 1, "loss": 2, "draw": 0, "unknown": 0,
                                  "call": 2, "put": 1, "callWin": 1, "callLoss": 1,
                                  "putWin": 0, "putLoss": 1, "winRate": 33.3},
                },
                "levels": {},
            },
            # This pair has NO signals in app1+app2 — should be excluded.
            {
                "pair": "NZDUSD_otc",
                "displayPair": "NZD/USD OTC",
                "category": "otc",
                "appPairStats": {
                    "app1+app3": {"total": 5, "win": 3, "loss": 2, "draw": 0, "unknown": 0,
                                  "call": 3, "put": 2, "callWin": 2, "callLoss": 1,
                                  "putWin": 1, "putLoss": 1, "winRate": 60.0},
                },
                "levels": {},
            },
        ],
    }

    import app.api.routes as routes
    import app.backtest_runner as br

    monkeypatch.setattr(routes, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(routes, "start_candle_poller", lambda: None)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: cached_backtest)
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: 12.3)
    # Make get_or_refresh_backtest a no-op (we already have cached data).
    async def _noop():
        return None
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/app-pair/app1+app2/pairs")
    assert r.status_code == 200, r.text
    data = r.json()

    assert data["subset"] == "app1+app2"
    assert data["subsetLabel"] == "App 1 + App 2"
    # Global aggregate across the 3 contributing pairs.
    g = data["global"]
    assert g["total"] == 18  # 5 + 10 + 3
    assert g["win"] == 12    # 4 + 7 + 1
    assert g["loss"] == 6    # 1 + 3 + 2
    assert g["gradedTotal"] == 18
    assert g["winRate"] == round((12 / 18) * 100, 1)
    assert g["call"] == 10  # 3 + 5 + 2
    assert g["put"] == 8    # 2 + 5 + 1
    # 3 pairs returned (NZDUSD excluded because it has no app1+app2 signals).
    pairs = data["pairs"]
    assert len(pairs) == 3
    # Sorted by win rate desc.
    assert pairs[0]["pair"] == "EURUSD_otc"   # 80%
    assert pairs[1]["pair"] == "GBPJPY_otc"   # 70%
    assert pairs[2]["pair"] == "AUDCAD_otc"   # 33.3%
    # Per-pair shape.
    p0 = pairs[0]
    assert p0["displayPair"] == "EUR/USD OTC"
    assert p0["category"] == "otc"
    assert p0["signals"] == 5
    assert p0["win"] == 4
    assert p0["loss"] == 1
    assert p0["gradedTotal"] == 5
    assert p0["winRate"] == 80.0
    assert p0["call"] == 3
    assert p0["put"] == 2
    assert p0["callWin"] == 3
    assert p0["callLoss"] == 0
    assert p0["putWin"] == 1
    assert p0["putLoss"] == 1
    assert data["cacheAgeSec"] == 12.3
    assert data["verdict"]["kind"] == "validated"


def test_app_pair_subset_pairs_endpoint_rejects_invalid_subset(monkeypatch):
    """GET /api/app-pair/INVALID/pairs returns 400 with the list of
    valid subsets so the client can recover gracefully."""
    import app.api.routes as routes
    monkeypatch.setattr(routes, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(routes, "start_candle_poller", lambda: None)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: None)
    async def _noop():
        return None
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/app-pair/INVALID/pairs")
    assert r.status_code == 400
    data = r.json()
    assert data["error"] == "invalid_subset"
    assert "validSubsets" in data
    assert "app1+app2" in data["validSubsets"]


def test_app_pair_subset_pairs_endpoint_handles_cold_cache(monkeypatch):
    """When the backtest cache is cold (None), the endpoint triggers a
    background refresh and returns empty pairs (rather than 500ing)."""
    import app.api.routes as routes
    monkeypatch.setattr(routes, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(routes, "start_candle_poller", lambda: None)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: None)
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: -1.0)
    refresh_called = {"count": 0}
    async def _refresh():
        refresh_called["count"] += 1
        return None
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _refresh)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/app-pair/app1+app2/pairs")
    assert r.status_code == 200
    data = r.json()
    assert data["subset"] == "app1+app2"
    assert data["pairs"] == []
    assert data["global"]["total"] == 0
    assert data["global"]["winRate"] is None
    assert refresh_called["count"] == 1  # did trigger a refresh


def test_app_pair_subset_pairs_endpoint_singleton_subset(monkeypatch):
    """A singleton subset like 'app1' (app1 alone, no agreement) returns
    every pair where app1 emitted a signal without any other app agreeing
    with it."""
    cached_backtest = {
        "verdict": {"kind": "validated", "message": "ok"},
        "perPair": [
            {
                "pair": "USDJPY_otc",
                "displayPair": "USD/JPY OTC",
                "category": "otc",
                "appPairStats": {
                    "app1": {"total": 7, "win": 5, "loss": 2, "draw": 0, "unknown": 0,
                             "call": 4, "put": 3, "callWin": 3, "callLoss": 1,
                             "putWin": 2, "putLoss": 1, "winRate": 71.4},
                },
                "levels": {},
            },
        ],
    }
    import app.api.routes as routes
    monkeypatch.setattr(routes, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(routes, "start_candle_poller", lambda: None)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: cached_backtest)
    monkeypatch.setattr(routes, "get_backtest_cache_age_sec", lambda: 0.0)
    async def _noop():
        return None
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    client = TestClient(fastapi_app)

    r = client.get("/api/app-pair/app1/pairs")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["subset"] == "app1"
    assert data["subsetLabel"] == "App 1 only"
    assert len(data["pairs"]) == 1
    assert data["pairs"][0]["pair"] == "USDJPY_otc"
    assert data["pairs"][0]["signals"] == 7
    assert data["pairs"][0]["winRate"] == 71.4
