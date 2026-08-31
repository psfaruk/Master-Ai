"""Tests for GET /api/live-winrate — the Signals tab's live win-rate panel.

Covers:
  - hasResult=false + empty aggregates when the backtest cache is cold
  - per-level rates pass straight through from the cached backtest
  - per-app-combination (appPair) aggregates are summed across pairs and
    the win rate is recomputed from the summed win/loss
  - the "overall" card equals the sum of every consensus level's outcomes
  - /api/app-pair-leaders and /api/live-winrate agree on appPairGlobal
    (both read the same shared _aggregate_app_pair_global helper)
"""

from __future__ import annotations

import pytest

from app.backtest_runner import BacktestCache


async def _noop_coro():
    return None


def _pair_entry(pair: str, app_pair_stats: dict) -> dict:
    return {"pair": pair, "appPairStats": app_pair_stats}


def _fake_payload() -> dict:
    """A minimal but structurally faithful cached-backtest payload."""
    return {
        "verdict": {"kind": "validated", "message": "ok"},
        "levels": {
            "3-agree": {"total": 10, "win": 7, "loss": 2, "unknown": 0, "draw": 1,
                        "winRate": 77.8},
            "2-agree": {"total": 20, "win": 8, "loss": 10, "unknown": 1, "draw": 1,
                        "winRate": 44.4},
            "conflict": {"total": 5, "win": 2, "loss": 3, "unknown": 0, "draw": 0,
                         "winRate": 40.0},
            "1-only": {"total": 4, "win": 1, "loss": 1, "unknown": 2, "draw": 0,
                       "winRate": 50.0},
        },
        "perPair": [
            _pair_entry("EURUSD_otc", {
                "app1+app2": {"total": 5, "win": 4, "loss": 1, "unknown": 0, "draw": 0},
                "app1+app3": {"total": 2, "win": 1, "loss": 1, "unknown": 0, "draw": 0},
            }),
            _pair_entry("USDCOP_otc", {
                "app1+app2": {"total": 3, "win": 1, "loss": 2, "unknown": 0, "draw": 0},
                "app2+app3": {"total": 1, "win": 0, "loss": 0, "unknown": 1, "draw": 0},
            }),
        ],
    }


@pytest.fixture()
def api(monkeypatch):
    """Import routes fresh and stub the backtest cache the standard way."""
    import app.api.routes as routes
    monkeypatch.setattr(routes, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(routes, "start_candle_poller", lambda: None)
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop_coro)
    monkeypatch.setattr(
        routes, "_get_cache",
        lambda: BacktestCache(refresh_in_progress=False, last_refresh_error=None),
    )
    return routes


def _client():
    from fastapi.testclient import TestClient
    from main import app as fastapi_app
    return TestClient(fastapi_app)


def test_live_winrate_cold_cache_reports_no_result(api, monkeypatch):
    monkeypatch.setattr(api, "get_cached_backtest", lambda: None)
    monkeypatch.setattr(api, "get_backtest_cache_age_sec", lambda: None)
    client = _client()

    r = client.get("/api/live-winrate")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["hasResult"] is False
    assert data["levels"] == {}
    assert data["overall"]["gradedTotal"] == 0
    assert data["overall"]["winRate"] is None
    # All 7 canonical subsets must still be present (zeroed) so the UI can
    # render a stable grid without missing cards.
    assert set(data["subsetKeys"]) == {
        "app1", "app2", "app3", "app1+app2", "app1+app3", "app2+app3", "app1+app2+app3",
    }
    for key in data["subsetKeys"]:
        assert data["appPair"][key]["gradedTotal"] == 0
        assert data["appPair"][key]["winRate"] is None


def test_live_winrate_levels_pass_through_and_overall_sums(api, monkeypatch):
    monkeypatch.setattr(api, "get_cached_backtest", lambda: _fake_payload())
    monkeypatch.setattr(api, "get_backtest_cache_age_sec", lambda: 5.0)
    client = _client()

    data = client.get("/api/live-winrate").json()
    assert data["hasResult"] is True
    assert data["levels"]["3-agree"]["winRate"] == 77.8
    assert data["levels"]["2-agree"]["winRate"] == 44.4

    # Overall = sum of all four levels: 10+20+5+4 = 39 signals,
    # wins 7+8+2+1 = 18, losses 2+10+3+1 = 16 → 18/(18+16) = 52.9%
    ov = data["overall"]
    assert ov["total"] == 39
    assert ov["win"] == 18
    assert ov["loss"] == 16
    assert ov["gradedTotal"] == 34
    assert ov["winRate"] == 52.9


def test_live_winrate_app_pair_aggregates_across_pairs(api, monkeypatch):
    monkeypatch.setattr(api, "get_cached_backtest", lambda: _fake_payload())
    monkeypatch.setattr(api, "get_backtest_cache_age_sec", lambda: 5.0)
    client = _client()

    ap = client.get("/api/live-winrate").json()["appPair"]
    # app1+app2: (4W/1L) + (1W/2L) = 5W/3L → 62.5%
    assert ap["app1+app2"]["win"] == 5
    assert ap["app1+app2"]["loss"] == 3
    assert ap["app1+app2"]["gradedTotal"] == 8
    assert ap["app1+app2"]["winRate"] == 62.5
    # app1+app3 only occurred on the first pair: 1W/1L → 50.0%
    assert ap["app1+app3"]["winRate"] == 50.0
    # app2+app3 only unknowns → no rate
    assert ap["app2+app3"]["winRate"] is None
    # Zeroed subset still present
    assert ap["app1"]["gradedTotal"] == 0


def test_live_winrate_agrees_with_app_pair_leaders(api, monkeypatch):
    """Both endpoints must derive appPair aggregates from the same helper."""
    monkeypatch.setattr(api, "get_cached_backtest", lambda: _fake_payload())
    monkeypatch.setattr(api, "get_backtest_cache_age_sec", lambda: 5.0)
    client = _client()

    a = client.get("/api/live-winrate").json()["appPair"]
    b = client.get("/api/app-pair-leaders").json()["appPairGlobal"]
    assert a == b


# ---------------------------------------------------------------------------
# /api/consensus-history subset filtering (the History tab's combination
# cards and the Signals tab's history panel tabs read this)
# ---------------------------------------------------------------------------


def _history_payload(now_sec: int) -> dict:
    """A cached backtest with per-pair cluster history across subsets."""
    ts = now_sec - 120  # 2 minutes ago — inside every window

    def _c(ts_off, subset, level, direction, outcome, pair="EURUSD_otc"):
        t = ts - ts_off * 60
        return {
            "ts": t,
            "level": level,
            "direction": direction,
            "n_apps": 2,
            "app_subset_key": subset,
            "agreeing_apps": subset.split("+"),
            "app_directions": {a: direction for a in subset.split("+")},
            "app_outcomes": {a: outcome for a in subset.split("+")},
            "appOutcomeLabels": {a: ("WIN" if outcome == 1 else "LOSS") for a in subset.split("+")},
            "outcome": outcome,
            "outcomeLabel": "WIN" if outcome == 1 else "LOSS",
            "agreeing_win": 1 if outcome == 1 else 0,
            "agreeing_loss": 0 if outcome == 1 else 1,
            "agreeing_draw": 0,
            "agreeing_unknown": 0,
            "pair": pair,
        }

    return {
        "verdict": {"kind": "validated"},
        "levels": {},
        "perPair": [
            {"pair": "EURUSD_otc", "displayPair": "EUR/USD OTC", "category": "otc",
             "history": [
                 _c(0, "app1+app2", "2-agree", "CALL", 1),
                 _c(1, "app1+app3", "2-agree", "PUT", 0),
                 _c(2, "app1+app2+app3", "3-agree", "CALL", 1),
                 _c(3, "app2+app3", "2-agree", "CALL", 1),
             ]},
        ],
    }


@pytest.fixture()
def hist_api(monkeypatch):
    import time
    import app.api.routes as routes

    now_sec = int(time.time())
    payload = _history_payload(now_sec)
    monkeypatch.setattr(routes, "start_poller", lambda: None)
    monkeypatch.setattr(routes, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(routes, "start_candle_poller", lambda: None)
    monkeypatch.setattr(routes, "get_or_refresh_backtest", _noop_coro)
    monkeypatch.setattr(routes, "get_cached_backtest", lambda: payload)
    return routes, payload


def test_consensus_history_subset_filter_scopes_items_and_summary(hist_api, monkeypatch):
    routes, _ = hist_api
    client = _client()

    r = client.get("/api/consensus-history", params={"subset": "app1+app2", "minutes": 60})
    assert r.status_code == 200, r.text
    data = r.json()
    # Only the app1+app2 clusters survive the filter…
    assert data["total"] == 1
    assert data["items"][0]["app_subset_key"] == "app1+app2"
    assert data["items"][0]["direction"] == "CALL"
    assert data["items"][0]["outcome"] == 1
    # …and the summary is computed over the FILTERED population: 1W/0L → 100%.
    assert data["summary"]["total"] == 1
    assert data["summary"]["wins"] == 1
    assert data["summary"]["losses"] == 0
    assert data["summary"]["winRate"] == 100.0
    # bySubset stays pre-filter so cards can show every combination.
    assert data["bySubset"]["app1+app2"]["total"] == 1
    assert data["bySubset"]["app1+app3"]["total"] == 1
    assert data["bySubset"]["app1+app2+app3"]["total"] == 1


def test_consensus_history_subset_plus_is_not_decoded_as_space(hist_api, monkeypatch):
    """A hand-typed ``?subset=app1+app2`` (literal +, form-decoded to a
    space server-side) must match the canonical subset key, not silently
    return zero rows."""
    routes, _ = hist_api
    client = _client()

    # Unencoded "+" arrives as "app1 app2" after form decoding.
    r = client.get("/api/consensus-history?subset=app1+app2&minutes=60")
    assert r.status_code == 200
    assert r.json()["total"] == 1, "literal + in subset query must still filter correctly"

    # %2B-encoded form behaves identically.
    r2 = client.get("/api/consensus-history?subset=app1%2Bapp2&minutes=60")
    assert r2.json()["total"] == 1


def test_consensus_history_level_2_agree_includes_all_combinations(hist_api, monkeypatch):
    """The "2-agree" tab/level must cover ALL three pairwise subsets."""
    routes, _ = hist_api
    client = _client()

    data = client.get("/api/consensus-history", params={"level": "2-agree", "minutes": 60}).json()
    assert data["total"] == 3
    got = {it["app_subset_key"] for it in data["items"]}
    assert got == {"app1+app2", "app1+app3", "app2+app3"}
    # 2 wins out of 3 graded → 66.7%
    assert data["summary"]["wins"] == 2
    assert data["summary"]["losses"] == 1
    assert data["summary"]["winRate"] == 66.7
