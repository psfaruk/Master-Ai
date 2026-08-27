"""END-TO-END: Railway redeploy simulation — the user's actual pain point.

The user redeploys the three upstream signal apps on Railway every few
days; every redeploy changes their subdomains, and the dashboard used to
silently stop receiving data until someone edited hardcoded URLs in FOUR
modules and redeployed THIS app too.

This test runs the FULL pipeline against THREE REAL local HTTP servers —
one per app, on separate ports, exactly like three separate Railway
deployments (actual httpx requests over TCP, no monkeypatched fetches) —
and walks the exact user workflow:

  1. Three apps are "deployed" (ports A1/A2/A3) and configured via
     POST /api/sources (the same call the Settings panel makes), pasting
     different URL shapes per app (bare host / no scheme / full endpoint).
  2. The dashboard shows a live 3-agree consensus and /api/backtest grades
     the resolved history — everything works.
  3. THE REDEPLOY: all three apps come back on NEW ports (Railway's new
     subdomains). Snapshots now report every app down.
  4. The user pastes the NEW URLs into the panel (POST /api/sources).
  5. WITHOUT any restart, the very next snapshot shows a live 3-agree
     consensus again, the app cards point at the new URLs, and the
     backtest runs against the new deployment.

Run standalone (builds its own temp files)::

    python tests/test_source_reconnect_e2e.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("APP2_CACHE_FILE", os.path.join(tempfile.mkdtemp(prefix="e2e-app2-"), "app2_cache.json"))
os.environ.setdefault("SIGNAL_LEDGER_FILE", os.path.join(tempfile.mkdtemp(prefix="e2e-ledger-"), "ledger.json"))
os.environ.setdefault("SOURCE_CONFIG_FILE", os.path.join(tempfile.mkdtemp(prefix="e2e-sources-"), "source_config.json"))


class MockUpstream:
    """ONE upstream app on its own port, serving realistic payloads.

    ``app`` selects which of the three apps to emulate (each has different
    endpoint paths AND payload shapes, like the real deployments).
    ``direction`` is the consensus direction it publishes for the current
    candle. History endpoints carry RESOLVED past candles with source
    outcomes + OHLC prices, so the backtest has real data to grade.
    """

    def __init__(self, app: str, direction: str = "CALL"):
        self.app = app
        self.direction = direction
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port: int = 0

    # ---- payload factory (evaluated per request so candles stay current)

    def _payloads(self) -> dict:
        d = self.direction  # "CALL" | "PUT"
        now = int(time.time())
        cur = now - now % 60
        c1, c2 = cur - 60, cur - 120
        cur_hm = datetime.fromtimestamp(cur, tz=timezone.utc).strftime("%H:%M")
        b = "/api"

        # Candle ground truth: candle 1 moves WITH the signal (a win),
        # candle 2 moves AGAINST it (a loss). Prices chosen so the source
        # self-reported outcomes agree with the candle math.
        if d == "CALL":
            win1 = {"a_open": 1.1000, "a_close": 1.1050}
            loss2 = {"a_open": 1.2000, "a_close": 1.1950}
        else:
            win1 = {"a_open": 1.1000, "a_close": 1.0950}
            loss2 = {"a_open": 1.2000, "a_close": 1.2050}

        if self.app == "app1":
            return {
                f"{b}/status": {"quotex_connected": True, "active_pairs": ["EUR/USD OTC"], "auth_mode": "session_token"},
                f"{b}/history": [
                    {
                        "id": 1, "pair": "EUR/USD OTC", "direction": d,
                        "created_at": c1 - 8, "entry_ts": c1, "target_close_ts": c1 + 60,
                        "confidence": 0.83, "source": "near_support", "result": "WIN",
                    },
                    {
                        "id": 2, "pair": "EUR/USD OTC", "direction": d,
                        "created_at": c2 - 8, "entry_ts": c2, "target_close_ts": c2 + 60,
                        "confidence": 0.74, "source": "doji_reversal", "result": "LOSS",
                    },
                    # The live prediction for the CURRENT candle — published
                    # immediately, resolved when the candle closes. The
                    # backtest pulls history at limit=5000, which includes it.
                    {
                        "id": 3, "pair": "EUR/USD OTC", "direction": d,
                        "created_at": cur - 3, "entry_ts": cur, "target_close_ts": cur + 60,
                        "confidence": 0.81, "source": "near_support", "result": "PENDING",
                    },
                ],
                f"{b}/live": [
                    {
                        "id": 4, "pair": "EUR/USD OTC", "direction": d,
                        "created_at": cur - 3, "entry_ts": cur, "target_close_ts": cur + 60,
                        "confidence": 0.81, "source": "near_support", "result": "PENDING",
                    },
                ],
            }

        if self.app == "app2":
            return {
                f"{b}/status": {"connected": True, "streams": {"active": [1, 2, 3]}},
                f"{b}/share-signals": {
                    "timestamp": now * 1000,
                    "rows": [
                        {
                            "pair": "EUR/USD OTC", "signal": d, "type": "OTC",
                            "time": cur_hm, "confidence": 77, "strength": "strong",
                            "last_update": 2, "live": True, "buyer_pct": 62, "seller_pct": 38,
                        },
                    ],
                },
            }

        # app3 (OTC Live Trading)
        return {
            f"{b}/token-status": {"connected": True, "has_env_token": True, "token_source": "env"},
            f"{b}/signals": [
                {
                    "asset": "eurusd-otc", "signal": d.lower(), "ctime": c1,
                    "result": "correct", "confidence": 0.7, **win1,
                },
                {
                    "asset": "eurusd-otc", "signal": d.lower(), "ctime": c2,
                    "result": "wrong", "confidence": 0.6, **loss2,
                },
            ],
            f"{b}/share-signals": {
                "signals": [
                    {
                        "asset": "eurusd-otc", "signal": d.lower(),
                        "time": cur * 1000, "confidence": 0.71,
                        "prediction_candle": {"open": 1.3000, "high": 1.3010, "low": 1.2995, "close": 1.3001},
                    },
                ],
            },
        }

    # ---- HTTP wiring -----------------------------------------------------

    def _handler(self):
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                path = urlsplit(self.path).path
                payloads = outer._payloads()
                if path in payloads:
                    body = json.dumps(payloads[path]).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_error(404)

            def log_message(self, *args):  # silence request logging
                pass

        return H

    def start(self) -> int:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self.port

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._thread.join(timeout=5)
            self._server = None

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def _deploy(direction: str):
    """Start one mock server per app — like three separate Railway deploys."""
    apps = {app_id: MockUpstream(app_id, direction) for app_id in ("app1", "app2", "app3")}
    for a in apps.values():
        a.start()
    return apps


def _teardown(apps):
    for a in apps.values():
        a.stop()


# ---------------------------------------------------------------------------
# The scenario
# ---------------------------------------------------------------------------

import pytest  # noqa: E402


@pytest.fixture()
def api(monkeypatch):
    """TestClient with pollers disabled (tests force refresh explicitly).

    Deliberately NOT used as a context manager: entering the client runs the
    app's lifespan, whose kick-off poll races the test's own refresh and
    can leave the snapshot cache empty (503). Without the lifespan, the
    tests' explicit ``?refresh=1`` polls are the only fetches.
    """
    import app.api.routes as routes

    monkeypatch.setattr(routes, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(routes, "start_candle_poller", lambda: None)
    monkeypatch.setattr(routes, "start_poller", lambda: None)
    monkeypatch.setattr(routes, "_schedule_reconnect", lambda: None)

    from fastapi.testclient import TestClient
    from main import app as fastapi_app

    yield TestClient(fastapi_app)


def test_railway_redeploy_reconnects_from_the_ui(api):
    deployment1 = _deploy("CALL")
    try:
        # ---- 1. Initial deployment: configure via the panel's endpoint ----
        # Each app's URL is pasted in a DIFFERENT shape — all must work.
        r = api.post("/api/sources", json={
            "apps": {
                "app1": {"baseUrl": deployment1["app1"].base},                      # full URL
                "app2": {"baseUrl": f"127.0.0.1:{deployment1['app2'].port}"},       # bare host, no scheme
                "app3": {"baseUrl": deployment1["app3"].base + "/api/share-signals"},  # full ENDPOINT URL
            },
            "probe": False,
        })
        assert r.status_code == 200, r.text
        applied = r.json()["applied"]
        # app2's scheme-less paste normalizes to https (right for Railway) —
        # on a local plain-HTTP mock that host can't be fetched, so re-save
        # it with an explicit scheme and assert the final state.
        assert applied["app2"] == f"https://127.0.0.1:{deployment1['app2'].port}"
        r = api.post("/api/sources", json={
            "apps": {"app2": {"baseUrl": deployment1["app2"].base}},
            "probe": False,
        })
        assert r.status_code == 200

        cfg_now = {a["id"]: a["baseUrl"] for a in api.get("/api/sources").json()["apps"]}
        assert cfg_now == {k: a.base for k, a in deployment1.items()}

        # ---- 2. Live consensus flows from all three apps ----
        snap = api.get("/api/snapshot?refresh=1").json()
        apps = {a["id"]: a for a in snap["apps"]}
        assert all(a["url"] == deployment1[a["id"]].base for a in apps.values())
        assert all(a["health"] == "ok" for a in apps.values()), apps

        pairs = snap["pairs"]
        assert pairs, "no pairs in snapshot"
        top = pairs[0]
        assert top["pair"] == "EURUSD_otc"
        assert top["consensus"]["level"] == "3-agree"
        assert top["consensus"]["direction"] == "CALL"
        assert sorted(top["consensus"]["agreeingApps"]) == ["app1", "app2", "app3"]
        sources = {s["source"] for s in top["latestCandle"]["signals"]}
        assert sources == {"app1", "app2", "app3"}

        # ---- 3. The backtest grades the resolved history ----
        bt = api.get("/api/backtest").json()
        assert "error" not in bt, bt
        assert bt["totalClusters"] >= 3, bt.get("totalClusters")
        levels = bt["levels"]
        assert levels["3-agree"]["total"] >= 1          # the live candle
        # Past candles: 1 graded win + 1 graded loss on the 2-agree bucket,
        # graded against App 3's candle closes.
        assert levels["2-agree"]["win"] >= 1
        assert levels["2-agree"]["loss"] >= 1
        eurusd = next(p for p in bt["perPair"] if p["pair"] == "EURUSD_otc")
        assert eurusd["gradedTotal"] >= 2
    finally:
        _teardown(deployment1)

    # ---- 4. THE REDEPLOY: new ports = new Railway subdomains ----
    deployment2 = _deploy("PUT")
    try:
        # Before the user reacts, every app is DOWN — the original bug.
        snap = api.get("/api/snapshot?refresh=1").json()
        apps = {a["id"]: a for a in snap["apps"]}
        assert all(a["health"] in ("down", "disconnected") for a in apps.values())

        # ---- 5. The user pastes the NEW urls into the panel ----
        r = api.post("/api/sources", json={
            "apps": {k: {"baseUrl": a.base} for k, a in deployment2.items()},
            "probe": True,   # panel default — probe the new urls inline
            "purgeCaches": ["app2", "app3"],
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert all(p["reachable"] for p in body["probes"].values())
        assert body["purged"] == ["app2", "app3"]

        # ---- 6. NO RESTART: the next poll already streams the new apps ----
        snap = api.get("/api/snapshot?refresh=1").json()
        apps = {a["id"]: a for a in snap["apps"]}
        assert all(a["url"] == deployment2[a["id"]].base for a in apps.values())
        assert all(a["health"] == "ok" for a in apps.values()), apps
        top = snap["pairs"][0]
        assert top["pair"] == "EURUSD_otc"
        assert top["consensus"]["level"] == "3-agree"
        assert top["consensus"]["direction"] == "PUT"
        assert sorted(top["consensus"]["agreeingApps"]) == ["app1", "app2", "app3"]

        # ---- 7. The backtest runs against the new deployment too ----
        bt = api.get("/api/backtest").json()
        assert "error" not in bt, bt
        assert bt["totalClusters"] >= 1
    finally:
        _teardown(deployment2)


if __name__ == "__main__":
    # Standalone runner (without pytest): reset singletons the same way the
    # suite's conftest does, then run the scenario once.
    from app.source_config import get_config

    import app.api.routes as routes

    routes.start_app2_cache_poller = lambda: None
    routes.start_candle_poller = lambda: None
    routes.start_poller = lambda: None
    routes._schedule_reconnect = lambda: None

    from fastapi.testclient import TestClient
    from main import app as fastapi_app

    get_config().reset_for_tests()
    client = TestClient(fastapi_app)

    d1 = _deploy("CALL")
    try:
        assert client.post("/api/sources", json={
            "apps": {k: {"baseUrl": a.base} for k, a in d1.items()},
            "probe": False,
        }).status_code == 200
        snap = client.get("/api/snapshot?refresh=1").json()
        assert snap["pairs"][0]["consensus"]["level"] == "3-agree"
        bt = client.get("/api/backtest").json()
        assert bt["levels"]["3-agree"]["total"] >= 1
        assert bt["levels"]["2-agree"]["win"] >= 1 and bt["levels"]["2-agree"]["loss"] >= 1
        print("phase 1 OK — live 3-agree + graded backtest from initial deployment")
    finally:
        _teardown(d1)

    d2 = _deploy("PUT")
    try:
        r = client.post("/api/sources", json={
            "apps": {k: {"baseUrl": a.base} for k, a in d2.items()},
            "probe": True, "purgeCaches": ["app2", "app3"],
        })
        assert r.status_code == 200
        snap = client.get("/api/snapshot?refresh=1").json()
        assert snap["pairs"][0]["consensus"]["level"] == "3-agree"
        assert snap["pairs"][0]["consensus"]["direction"] == "PUT"
        print("phase 2 OK — 3-agree restored from the NEW urls, no restart")
    finally:
        _teardown(d2)
    print("E2E PASSED")
