"""Regression tests for the deep-audit fixes.

Each test names the bug it locks down so a future refactor that reintroduces
it fails loudly instead of silently corrupting numbers.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app import candle_fetcher as cf
from app.candle_fetcher import Candle, grade_signal_against_candle


def _candle(**kw):
    now = int(time.time())
    ct = kw.pop("candle_time", (now // 60 - 5) * 60)
    base = dict(
        pair="EURUSD_otc", candle_time=ct, open=1.1000, high=None, low=None,
        close=1.1010, result=None, app3_direction=None,
        fetched_at=float((ct + 60) * 1000), is_final=True,
    )
    base.update(kw)
    return Candle(**base)


# ---------------------------------------------------------------------------
# AUDIT-1: live candle graded against a mid-candle price
# ---------------------------------------------------------------------------


def test_final_candle_grades_normally():
    up = _candle(open=1.0, close=1.5, is_final=True)
    assert grade_signal_against_candle("CALL", up) == "WIN"
    assert grade_signal_against_candle("PUT", up) == "LOSS"
    down = _candle(open=1.5, close=1.0, is_final=True)
    assert grade_signal_against_candle("CALL", down) == "LOSS"
    assert grade_signal_against_candle("PUT", down) == "WIN"


def test_flat_candle_is_a_draw():
    assert grade_signal_against_candle("CALL", _candle(open=1.0, close=1.0)) == "DRAW"


def test_live_candle_captured_mid_candle_is_never_graded():
    """AUDIT-1 — the win-rate corruption bug.

    A live row captured 5s into its minute carries close≈open. The old rule
    only blocked grading while the minute was still current, so the moment
    the clock rolled over it graded that stale mid-candle price as a real
    outcome — and App 3's 500-row history cap means the authoritative close
    may never arrive to correct it.
    """
    now = int(time.time())
    ct = (now // 60 - 5) * 60          # a candle that closed 4 minutes ago
    captured_mid = _candle(
        candle_time=ct,
        fetched_at=float((ct + 5) * 1000),  # captured 5s INTO the candle
        is_final=False,
        open=1.0, close=1.0001,
    )
    assert grade_signal_against_candle("CALL", captured_mid) == "UNKNOWN"
    assert grade_signal_against_candle("PUT", captured_mid) == "UNKNOWN"


def test_live_candle_captured_after_close_is_gradable():
    """The legitimate case: the live endpoint still describes the previous
    candle when we poll just after it closed. That close IS final."""
    now = int(time.time())
    ct = (now // 60 - 5) * 60
    captured_after = _candle(
        candle_time=ct,
        fetched_at=float((ct + 62) * 1000),  # captured 2s AFTER close
        is_final=False,
        open=1.0, close=1.5,
    )
    assert grade_signal_against_candle("CALL", captured_after) == "WIN"


def test_forming_candle_is_not_graded():
    now = int(time.time())
    ct = (now // 60) * 60  # the candle currently forming
    forming = _candle(
        candle_time=ct, fetched_at=float(now * 1000), is_final=False,
        open=1.0, close=1.2,
    )
    assert grade_signal_against_candle("CALL", forming) == "UNKNOWN"


def test_missing_or_nan_prices_are_not_graded():
    assert grade_signal_against_candle("CALL", None) == "UNKNOWN"
    assert grade_signal_against_candle("CALL", _candle(close=float("nan"))) == "UNKNOWN"
    assert grade_signal_against_candle("CALL", _candle(open=float("nan"))) == "UNKNOWN"


# ---------------------------------------------------------------------------
# AUDIT-2: unbounded candle cache
# ---------------------------------------------------------------------------


def test_prune_drops_candles_past_retention():
    """AUDIT-2 — the cache grew by (pairs x 1440) entries per day and nothing
    was ever removed, so the container was eventually OOM-killed."""
    cf.reset_candle_cache_for_tests()
    st = cf._get_state()
    now = int(time.time())
    fresh_ct = (now // 60 - 5) * 60
    old_ct = fresh_ct - (cf.MAX_CANDLE_AGE_SEC + 3600)

    st.candles["EURUSD_otc"] = {
        fresh_ct: _candle(candle_time=fresh_ct),
        old_ct: _candle(candle_time=old_ct),
    }
    cf._prune_candles(st)

    remaining = st.candles["EURUSD_otc"]
    assert fresh_ct in remaining
    assert old_ct not in remaining


def test_prune_caps_per_pair_depth(monkeypatch):
    """The per-pair cap is a SECOND line of defence behind the age filter.
    24h of 1-minute candles is 1440 entries, below the real 1500 cap, so the
    cap only bites on duplicate/garbage candle times. Shrink it here to
    exercise the branch in isolation."""
    monkeypatch.setattr(cf, "MAX_CANDLES_PER_PAIR", 10)
    cf.reset_candle_cache_for_tests()
    st = cf._get_state()
    base = (int(time.time()) // 60) * 60
    st.candles["EURUSD_otc"] = {
        base - i * 60: _candle(candle_time=base - i * 60) for i in range(60)
    }
    cf._prune_candles(st)
    kept = st.candles["EURUSD_otc"]
    assert len(kept) == 10
    # The NEWEST candles are the ones kept.
    assert max(kept) == base
    assert min(kept) == base - 9 * 60


def test_prune_removes_empty_pair_buckets():
    cf.reset_candle_cache_for_tests()
    st = cf._get_state()
    old_ct = int(time.time()) - (cf.MAX_CANDLE_AGE_SEC + 7200)
    st.candles["DEADPAIR"] = {old_ct: _candle(candle_time=old_ct)}
    cf._prune_candles(st)
    assert "DEADPAIR" not in st.candles


# ---------------------------------------------------------------------------
# AUDIT-3: refresh stampede / untracked task
# ---------------------------------------------------------------------------


def test_opportunistic_refresh_is_a_noop_without_an_event_loop():
    """AUDIT-3 — get_candles_for_pair is sync and reachable from sync callers.
    A bare asyncio.create_task there raises RuntimeError and 500s the
    request that triggered it."""
    cf.reset_candle_cache_for_tests()
    # No running loop here — must not raise.
    out = cf.get_candles_for_pair("NOSUCHPAIR", min_count=50)
    assert out == []


def test_opportunistic_refresh_is_rate_limited():
    """For a pair App 3 doesn't track the count never reaches min_count, so
    every request used to fire another refresh."""
    async def scenario():
        cf.reset_candle_cache_for_tests()
        calls = {"n": 0}

        async def fake_refresh():
            calls["n"] += 1

        orig = cf.refresh_candles
        cf.refresh_candles = fake_refresh
        try:
            for _ in range(10):
                cf.get_candles_for_pair("NOSUCHPAIR", min_count=50)
            await asyncio.sleep(0)  # let the scheduled task run
            await asyncio.sleep(0)
        finally:
            cf.refresh_candles = orig
        return calls["n"]

    assert asyncio.run(scenario()) == 1


def test_opportunistic_task_failure_is_logged_not_orphaned():
    async def scenario():
        cf.reset_candle_cache_for_tests()

        async def boom():
            raise RuntimeError("upstream down")

        orig = cf.refresh_candles
        cf.refresh_candles = boom
        try:
            cf.get_candles_for_pair("NOSUCHPAIR", min_count=50)
            st = cf._get_state()
            tasks = list(st.opportunistic_tasks)
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.sleep(0)
            # The done-callback retrieves the exception and drops the task.
            return st.opportunistic_tasks
        finally:
            cf.refresh_candles = orig

    assert asyncio.run(scenario()) == set()


# ---------------------------------------------------------------------------
# AUDIT-4: shared HTTP client
# ---------------------------------------------------------------------------


def test_shared_client_is_reused_across_calls():
    """AUDIT-4 — a fresh AsyncClient per fetch meant a full TLS handshake on
    every poll (up to ~1.25/s per upstream during the burst window)."""
    from app.http_fetcher import close_shared_client, get_shared_client

    async def scenario():
        a = await get_shared_client()
        b = await get_shared_client()
        assert a is b
        await close_shared_client()
        c = await get_shared_client()
        assert c is not a, "a closed client must be replaced, not reused"
        await close_shared_client()

    asyncio.run(scenario())


def test_injected_client_is_not_closed_by_the_fetcher():
    """Callers that pass their own client keep ownership of it."""
    import httpx
    from app.http_fetcher import fetch_json_with_timeout

    async def scenario():
        transport = httpx.MockTransport(
            lambda req: httpx.Response(200, json={"ok": True})
        )
        async with httpx.AsyncClient(transport=transport) as client:
            got = await fetch_json_with_timeout("https://example.test/x", client=client)
            assert got == {"ok": True}
            assert not client.is_closed

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# AUDIT-5 / AUDIT-6: shutdown flush + diag visibility
# ---------------------------------------------------------------------------


def test_diag_exposes_ledger_depth():
    """AUDIT-6 — App 3's history-depth problem has to be observable. Without
    perSource depth in /api/diag there is no way to tell 'the ledger is
    working' from 'the ledger is empty'."""
    from fastapi.testclient import TestClient
    from app.signal_ledger import record_signal
    import main

    now = int(time.time()) // 60 * 60
    for i in range(3):
        record_signal(
            source="app3", pair="EURUSD_otc", candle_time=now - i * 60,
            direction="CALL", first_seen_sec=now - i * 60 - 30,
        )
    with TestClient(main.app) as client:
        d = client.get("/api/diag").json()
    assert "signalLedger" in d
    assert d["signalLedger"]["perSource"]["app3"]["count"] == 3
    assert d["signalLedger"]["perSource"]["app3"]["depthMin"] == 2.0


def test_lifespan_shutdown_flushes_the_ledger(tmp_path, monkeypatch):
    """AUDIT-5 — the ledger's disk write is debounced to 20s, so without an
    explicit flush the last ~20s of signals are lost on every redeploy."""
    import json
    from fastapi.testclient import TestClient
    from app.signal_ledger import activate_ledger, record_signal, reset_ledger_for_tests
    import main

    path = str(tmp_path / "ledger.json")
    reset_ledger_for_tests()
    activate_ledger(path)
    now = int(time.time()) // 60 * 60
    record_signal(
        source="app1", pair="GBPUSD_otc", candle_time=now,
        direction="PUT", first_seen_sec=now - 20,
    )

    with TestClient(main.app):
        pass  # entering + leaving runs startup then the shutdown hook

    saved = json.loads(open(path).read())
    assert len(saved) == 1
    assert saved[0]["pair"] == "GBPUSD_otc"
