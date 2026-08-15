"""Regression tests for the bug fixes applied during the deep review.

Each test names the bug it locks down so future contributors know why the
behavior is being asserted.
"""

from __future__ import annotations

from app import app2_cache


# ---------------------------------------------------------------------------
# Bug #1: NO_STORE_HEADERS must be applied to every JSON response.
# ---------------------------------------------------------------------------


def test_no_store_headers_applied_on_aggregated():
    """Every JSON endpoint must carry Cache-Control: no-store + CORS *."""
    from app.api import routes as api_routes

    # We can't easily run the full FastAPI app without starting the
    # background pollers (which would call real upstreams). Instead, we
    # verify the helper that every endpoint uses.
    response = api_routes._json({"ok": True})
    assert response.headers["cache-control"] == "no-store, no-cache, must-revalidate"
    assert response.headers["access-control-allow-origin"] == "*"


# ---------------------------------------------------------------------------
# Bug #5: _merge_health should always return a "health" key so the caller's
# `merged["health"]` doesn't KeyError when the health fetch failed.
# ---------------------------------------------------------------------------


def test_merge_health_returns_health_key_on_health_failure():
    from app.signal_aggregator import NormalizeResult, _merge_health

    sig = NormalizeResult(health="ok", detail="ok", error=None)
    # health_result is None (e.g. health fetch raised an exception).
    merged = _merge_health(sig, None)
    assert "health" in merged
    assert merged["health"] == "ok"  # falls back to sig_result.health
    assert merged["live"] is True


def test_merge_health_returns_health_key_on_health_error_dict():
    from app.signal_aggregator import NormalizeResult, _merge_health

    sig = NormalizeResult(health="down", error="fetch_failed")
    merged = _merge_health(sig, {"error": "health_fetch_failed"})
    assert merged["health"] == "down"
    assert merged["live"] is False


def test_merge_health_uses_health_endpoint_when_present():
    from app.signal_aggregator import NormalizeResult, _merge_health

    sig = NormalizeResult(health="ok")
    hr = {"health": "token_expired", "detail": "session token expired", "live": False, "token_expired": True}
    merged = _merge_health(sig, hr)
    # Health endpoint wins.
    assert merged["health"] == "token_expired"
    assert merged["token_expired"] is True


# ---------------------------------------------------------------------------
# Bug #4: _newest_candle_by_pair must work and be a top-level function.
# ---------------------------------------------------------------------------


def test_newest_candle_by_pair_picks_newest():
    """Verifies the closure-bug refactor is functionally equivalent."""
    from app.api.routes import _newest_candle_by_pair

    class S:
        def __init__(self, pair, candle_time):
            self.pair = pair
            self.candle_time = candle_time

    signals = [
        S("USDCOP_otc", 100),
        S("USDCOP_otc", 200),
        S("EURUSD_otc", 150),
        S("USDCOP_otc", 50),
    ]
    out = _newest_candle_by_pair(signals)
    assert out == {"USDCOP_otc": 200, "EURUSD_otc": 150}


# ---------------------------------------------------------------------------
# Bug #2 / #3: `re` must be importable at module level (no mid-file imports).
# ---------------------------------------------------------------------------


def test_app2_cache_module_exports_hh_mm_re():
    """The _HH_MM_RE constant is module-level after the fix."""
    import re

    assert hasattr(app2_cache, "_HH_MM_RE")
    assert isinstance(app2_cache._HH_MM_RE, re.Pattern)


def test_backtest_runner_module_exports_draw_re():
    """The _DRAW_RE constant is module-level after the fix."""
    import re

    from app import backtest_runner

    assert hasattr(backtest_runner, "_DRAW_RE")
    assert isinstance(backtest_runner._DRAW_RE, re.Pattern)


# ---------------------------------------------------------------------------
# Bug #7: lifespan shutdown cancels background tasks cleanly.
# ---------------------------------------------------------------------------


def test_background_pollers_can_be_cancelled():
    """Sanity check that the lifespan shutdown hook can find and cancel the
    background tasks. We don't actually start the full FastAPI app here —
    we just verify the get_state/getter accessors work as the lifespan hook
    expects."""
    from app.app2_cache import _get_state as app2_state
    from app.candle_fetcher import _get_state as candle_state
    from app.snapshot_poller import _get_state as snap_state

    # Each poller state exposes its asyncio task under a (slightly different)
    # attribute name — task for app2/candle, poll_task for the snapshot poller.
    for getter, attr in (
        (app2_state, "task"),
        (candle_state, "task"),
        (snap_state, "poll_task"),
    ):
        st = getter()
        assert hasattr(st, attr), f"{getter.__module__} state must expose {attr!r}"
        # task is None initially (poller not started). Cancelling a None task
        # must NOT raise — the lifespan hook checks `is not None and not done()`.
        task = getattr(st, attr)
        if task is not None and not task.done():
            task.cancel()
