"""API tests for /api/sources — runtime upstream URL management.

Drives the real FastAPI app with TestClient, exercising exactly what the
dashboard's Signal Sources panel does:

- GET returns the full effective config (3 apps + resolved endpoints)
- POST validates atomically (one bad URL rejects everything, 400)
- POST saves + live-applies new URLs — a follow-up aggregate_signals()
  fetches from the NEW Railway URLs and produces a 3-agree consensus
- POST /api/sources/test probes a candidate URL WITHOUT saving it
- purgeCaches clears App 2's history cache when its URL changed
- SOURCE_ADMIN_TOKEN write-protection
- reset restores env/default URLs
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import pytest

from app import app2_cache, signal_aggregator, source_config

NEW_APP1 = "https://redeployed-app1-production.up.railway.app"
NEW_APP2 = "https://redeployed-app2-production.up.railway.app"
NEW_APP3 = "https://redeployed-app3-production.up.railway.app"


def new_world_routes():
    """Canned upstream payloads served at the REDEPLOYED URLs.

    Timestamps are computed per call so a test that runs across a candle
    boundary still lands everything on the CURRENT candle.
    """
    now_sec = int(time.time())
    current_candle = (now_sec // 60) * 60
    current_hm = datetime.fromtimestamp(current_candle, tz=timezone.utc).strftime("%H:%M")
    return {
        f"{NEW_APP1}/api/status": {"quotex_connected": True, "active_pairs": ["USD/COP OTC"], "auth_mode": "session_token"},
        f"{NEW_APP2}/api/status": {"connected": True, "streams": {"active": [1, 2, 3]}},
        f"{NEW_APP3}/api/token-status": {"connected": True, "has_env_token": True, "token_source": "env"},
        f"{NEW_APP1}/api/history": [{
            "id": 1,
            "pair": "USD/COP OTC",
            "direction": "CALL",
            "created_at": current_candle - 8,
            "entry_ts": current_candle,
            "target_close_ts": current_candle + 60,
            "confidence": 0.82,
            "source": "near_support",
            "result": "PENDING",
        }],
        f"{NEW_APP1}/api/live": [],
        f"{NEW_APP2}/api/share-signals": {
            "timestamp": now_sec * 1000,
            "rows": [{
                "pair": "USD/COP OTC", "signal": "CALL", "type": "OTC",
                "time": current_hm, "confidence": 80, "strength": "strong",
                "last_update": 2, "live": True, "buyer_pct": 60, "seller_pct": 40,
            }],
        },
        f"{NEW_APP3}/api/share-signals": {
            "signals": [{"asset": "usdcop-otc", "signal": "call", "time": current_candle * 1000, "confidence": 0.7}],
        },
        f"{NEW_APP3}/api/signals": {"signals": []},
    }


@pytest.fixture
def client(monkeypatch):
    """TestClient with the pollers disabled and URL changes never kicking a
    real network reconnect (tests must not hit the live Railway apps)."""
    import app.api.routes as routes

    monkeypatch.setattr(routes, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(routes, "start_candle_poller", lambda: None)
    monkeypatch.setattr(routes, "_schedule_reconnect", lambda: None)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app

    return TestClient(fastapi_app)


@pytest.fixture
def probe_ok(monkeypatch):
    """Probe every candidate endpoint as healthy with 3 rows."""
    async def fake_fetch(url, timeout_sec=None, retries=1):
        return {"rows": [1, 2, 3], "ok": True}

    monkeypatch.setattr(source_config, "fetch_json_with_timeout", fake_fetch)
    return fake_fetch


@pytest.fixture(autouse=True)
def _clean_app2_cache():
    """Isolate the process-wide App 2 history cache per test.

    Other tests in this file drive real fetch_app2() calls that record
    entries into the shared cache; without a reset the purge assertions
    below would see foreign entries.
    """
    app2_cache.reset_app2_cache_for_tests()
    yield
    app2_cache.reset_app2_cache_for_tests()


# ---------------------------------------------------------------------------
# GET /api/sources
# ---------------------------------------------------------------------------


def test_get_sources_returns_three_apps_with_defaults(client):
    r = client.get("/api/sources")
    assert r.status_code == 200
    data = r.json()
    apps = {a["id"]: a for a in data["apps"]}
    assert set(apps) == {"app1", "app2", "app3"}
    for app_id, app in apps.items():
        assert app["baseUrl"] == source_config.DEFAULT_BASE_URLS[app_id]
        assert app["source"] == "default"
        assert app["isCustom"] is False
        assert app["endpoints"], f"{app_id} has no resolved endpoints"
    # A sample endpoint URL is fully built.
    assert apps["app2"]["endpoints"]["signals"]["url"] == (
        source_config.DEFAULT_BASE_URLS["app2"] + "/api/share-signals"
    )


# ---------------------------------------------------------------------------
# POST /api/sources — validation
# ---------------------------------------------------------------------------


def test_post_rejects_invalid_url_atomically(client, probe_ok):
    before = source_config.get_config().to_dict()
    r = client.post("/api/sources", json={
        "apps": {
            "app1": {"baseUrl": "https://good-change.example"},
            "app2": {"baseUrl": "https://bad url with spaces.example"},
        },
    })
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_url"
    # NOTHING was applied — not even app1's good URL.
    after = source_config.get_config().to_dict()
    assert after == before


def test_post_rejects_unknown_app_and_empty_body(client, probe_ok):
    r = client.post("/api/sources", json={"apps": {"app9": {"baseUrl": "https://x.example"}}})
    assert r.status_code == 400
    r = client.post("/api/sources", json={"apps": {}})
    assert r.status_code == 400
    r = client.post("/api/sources", json={})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# POST /api/sources — the happy path: save + live-apply + probe
# ---------------------------------------------------------------------------


def test_post_applies_new_urls_and_aggregator_follows(client, probe_ok, monkeypatch):
    # The aggregator's fetches land on the NEW urls; serve them from a route
    # table like the real redeployed apps would.
    routes_map = new_world_routes()

    async def fake_fetch(url, timeout_sec=None, **kwargs):
        for key in sorted(routes_map, key=len, reverse=True):
            if url.startswith(key):
                return routes_map[key]
        return None

    monkeypatch.setattr(signal_aggregator, "fetch_json_with_timeout", fake_fetch)

    # 1. Save the redeployed URLs through the API (exactly what the UI does).
    r = client.post("/api/sources", json={
        "apps": {
            "app1": {"baseUrl": NEW_APP1},
            "app2": {"baseUrl": NEW_APP2 + "/"},  # trailing slash tolerated
            "app3": {"baseUrl": NEW_APP3},
        },
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok"] is True
    assert data["applied"]["app2"] == NEW_APP2  # normalized
    assert set(data["probes"]) == {"app1", "app2", "app3"}
    assert all(p["reachable"] for p in data["probes"].values())

    # 2. GET reflects the saved state.
    apps = {a["id"]: a for a in client.get("/api/sources").json()["apps"]}
    assert apps["app1"]["baseUrl"] == NEW_APP1
    assert apps["app1"]["source"] == "custom"
    assert apps["app1"]["endpoints"]["signals"]["url"] == NEW_APP1 + "/api/history?limit=500"

    # 3. THE LIVE PART — the aggregator now fetches from the NEW URLs and
    #    produces a 3-agree consensus, without any restart.
    import asyncio

    agg = asyncio.run(signal_aggregator.aggregate_signals(1800))
    assert agg.pairs, "no pairs after reconnect"
    top = agg.pairs[0]
    assert top.pair == "USDCOP_otc"
    assert top.consensus.level == "3-agree"
    assert sorted(top.consensus.agreeing_apps) == ["app1", "app2", "app3"]


def test_post_with_probe_false_skips_probes(client, monkeypatch):
    called = {"n": 0}

    async def failing_probe(*a, **k):
        called["n"] += 1
        raise AssertionError("probe should not run")

    monkeypatch.setattr(source_config, "probe_app", failing_probe)
    r = client.post("/api/sources", json={
        "apps": {"app1": {"baseUrl": "https://no-probe.example"}},
        "probe": False,
    })
    assert r.status_code == 200
    assert "probes" not in r.json()
    assert called["n"] == 0


# ---------------------------------------------------------------------------
# POST /api/sources/test — probe without saving
# ---------------------------------------------------------------------------


def test_sources_test_probes_candidate_without_saving(client, probe_ok):
    before = source_config.get_config().get_base_url("app3")
    r = client.post("/api/sources/test", json={"app": "app3", "baseUrl": NEW_APP3})
    assert r.status_code == 200
    data = r.json()
    assert data["reachable"] is True
    assert data["probeTarget"] == "candidate"
    assert data["baseUrl"] == NEW_APP3
    assert set(data["endpoints"]) == {"signals", "history", "health"}
    assert all(e["ok"] for e in data["endpoints"].values())
    # Nothing saved.
    assert source_config.get_config().get_base_url("app3") == before


def test_sources_test_against_a_dead_url_reports_failures(client, monkeypatch):
    async def dead(url, timeout_sec=None, retries=1):
        raise RuntimeError("All connection attempts failed")

    monkeypatch.setattr(source_config, "fetch_json_with_timeout", dead)
    r = client.post("/api/sources/test", json={"app": "app1"})
    assert r.status_code == 200
    data = r.json()
    assert data["reachable"] is False
    assert all(not e["ok"] for e in data["endpoints"].values())
    assert all("connection" in e["error"].lower() for e in data["endpoints"].values())


def test_sources_test_validates_url_and_app(client):
    r = client.post("/api/sources/test", json={"app": "app1", "baseUrl": "bad url"})
    assert r.status_code == 400
    r = client.post("/api/sources/test", json={"app": "nope"})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# purgeCaches
# ---------------------------------------------------------------------------


def test_purge_clears_app2_history_only_when_url_changed(client, probe_ok):
    candle = (int(time.time()) // 60) * 60
    entry = app2_cache.CachedSignal(
        pair="USDCOP_otc", signal="CALL", confidence=0.5, strength=None,
        candle_time=candle, first_seen_sec=candle, captured_at=time.time() * 1000,
        last_tick_age_sec=None, live=True, buyer_pct=None, seller_pct=None,
    )
    app2_cache.record_app2_signals([entry])
    assert app2_cache.get_app2_cache_size() == 1

    # Changing app2's URL WITH purge → cache cleared.
    r = client.post("/api/sources", json={
        "apps": {"app2": {"baseUrl": NEW_APP2}},
        "purgeCaches": ["app2"],
    })
    assert r.status_code == 200
    assert r.json()["purged"] == ["app2"]
    assert app2_cache.get_app2_cache_size() == 0

    # Re-seed, then save the SAME url again — no purge this time.
    app2_cache.record_app2_signals([entry])
    r = client.post("/api/sources", json={
        "apps": {"app2": {"baseUrl": NEW_APP2}},
        "purgeCaches": ["app2"],
    })
    assert r.status_code == 200
    assert r.json()["purged"] == []
    assert app2_cache.get_app2_cache_size() == 1


# ---------------------------------------------------------------------------
# SOURCE_ADMIN_TOKEN write protection
# ---------------------------------------------------------------------------


def test_admin_token_blocks_writes_but_not_reads(client, monkeypatch):
    monkeypatch.setenv("SOURCE_ADMIN_TOKEN", "sekret")
    r = client.post("/api/sources", json={"apps": {"app1": {"baseUrl": "https://x.example"}}})
    assert r.status_code == 401
    assert client.get("/api/sources").status_code == 200  # reads stay open

    r = client.post(
        "/api/sources",
        json={"apps": {"app1": {"baseUrl": "https://x.example"}}},
        headers={"X-Admin-Token": "wrong"},
    )
    assert r.status_code == 401
    r = client.post(
        "/api/sources",
        json={"apps": {"app1": {"baseUrl": "https://x.example"}}},
        headers={"X-Admin-Token": "sekret"},
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# POST /api/sources/reset
# ---------------------------------------------------------------------------


def test_reset_restores_previous_urls(client, probe_ok):
    client.post("/api/sources", json={"apps": {"app1": {"baseUrl": NEW_APP1}}})
    assert source_config.get_config().get_base_url("app1") == NEW_APP1

    r = client.post("/api/sources/reset", json={"apps": ["app1"]})
    assert r.status_code == 200
    assert source_config.get_config().get_base_url("app1") == (
        source_config.DEFAULT_BASE_URLS["app1"]
    )
