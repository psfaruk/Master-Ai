"""Regression tests for the 2026-08-30 deep-review fix round.

Each test names the bug it locks down. Run with::

    pytest tests/test_deep_fixes.py -v
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone

import pytest

from app import app2_cache
from app import backtest_runner as br
from app import candle_fetcher
from app.signal_normalize import candle_floor, resolve_clock_to_candle, to_unix_seconds


# ---------------------------------------------------------------------------
# FIX 1 — resolve_clock_to_candle: whole-hour timezones within ±90 min of
# UTC used to be accepted as literal UTC, landing every App 2 signal one
# hour in the future (and outside its true candle). The minute-of-hour
# recovery now runs BEFORE the wide literal-UTC acceptance.
# ---------------------------------------------------------------------------

def _mk_ref(hour=12, minute=7, sec=30):
    return int(datetime(2025, 1, 1, hour, minute, sec, tzinfo=timezone.utc).timestamp())


def test_clock_utc_plus_1_renderer_lands_on_correct_candle():
    """A source rendering UTC+1 and saying "13:05" means the 12:05 UTC candle."""
    ref = _mk_ref(12, 7, 30)
    got = resolve_clock_to_candle("13:05", ref)
    assert got == candle_floor(ref - 150), (
        f"UTC+1 rendering was accepted as literal UTC ({got}); "
        "every App 2 signal would bucket one hour into the future"
    )


def test_clock_utc_minus_1_renderer_lands_on_correct_candle():
    """A source rendering UTC-1 and saying "11:05" means the 12:05 UTC candle."""
    ref = _mk_ref(12, 7, 30)
    got = resolve_clock_to_candle("11:05", ref)
    assert got == candle_floor(ref - 150)


def test_clock_utc_plus_6_renderer_still_recovered():
    ref = _mk_ref(12, 7, 30)
    got = resolve_clock_to_candle("18:05", ref)
    assert got == candle_floor(ref - 150)


def test_clock_genuine_utc_current_candle_unchanged():
    ref = _mk_ref(12, 7, 30)
    assert resolve_clock_to_candle("12:07", ref) == candle_floor(ref)


def test_clock_genuine_utc_next_candle_prediction_unchanged():
    ref = _mk_ref(12, 7, 30)
    assert resolve_clock_to_candle("12:08", ref) == candle_floor(ref) + 60


def test_clock_genuine_utc_stale_string_unchanged():
    """A stale-but-UTC string (stream died 20 min ago) keeps its stated time."""
    ref = _mk_ref(12, 7, 30)
    assert resolve_clock_to_candle("11:47", ref) == candle_floor(ref) - 20 * 60


def test_clock_garbage_strings_fall_back_to_ref_candle():
    ref = _mk_ref(12, 7, 30)
    for bad in ("", "—", "25:99", "not-a-time"):
        assert resolve_clock_to_candle(bad, ref) == candle_floor(ref)


# ---------------------------------------------------------------------------
# FIX (signal_normalize) — naive ISO strings must be read as UTC, not in
# the server's local timezone.
# ---------------------------------------------------------------------------

def test_naive_iso_string_parsed_as_utc(monkeypatch):
    monkeypatch.setenv("TZ", "Asia/Dhaka")  # UTC+6 — would shift by 6h if naive
    ts = to_unix_seconds("2025-01-01T12:00:00")
    expected = int(datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc).timestamp())
    assert ts == expected


def test_iso_string_with_z_suffix_parsed_as_utc():
    ts = to_unix_seconds("2025-01-01T12:00:00Z")
    expected = int(datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc).timestamp())
    assert ts == expected


# ---------------------------------------------------------------------------
# FIX 2 — run_backtest double-counted (source, pair, candle) duplicates:
# App 3's resolved history + live feed routinely BOTH describe the
# just-closed candle, inflating totalSignals and the per-source stats.
# ---------------------------------------------------------------------------

def _run_backtest_with_monkey(monkeypatch, app1_payload, app3_hist, app3_live, app2_records=None):
    """Drive run_backtest() against a synthetic feed. Returns the result."""
    async def fake_fetch(url, **kw):
        if "minimum-pair" in url:
            return app1_payload
        if "otclivedata" in url and "share-signals" in url:
            return app3_live
        if "otclivedata" in url:
            return app3_hist
        return {"signals": []}

    def fake_grade(pair, candle_time, direction):
        return (None, "WIN" if direction == "CALL" else "LOSS")

    async def fake_refresh():
        return None

    monkeypatch.setattr(br, "fetch_json_with_timeout", fake_fetch)
    monkeypatch.setattr(br, "refresh_candles", fake_refresh)
    monkeypatch.setattr(br, "grade_signal", fake_grade)
    monkeypatch.setattr(br, "get_all_cached_app2_signals", lambda: app2_records or [])
    monkeypatch.setattr(br, "start_app2_cache_poller", lambda: None)
    monkeypatch.setattr(br, "start_candle_poller", lambda: None)
    monkeypatch.setattr(br, "activate_ledger", lambda *a, **kw: None)
    monkeypatch.setattr(br, "flush_ledger", lambda *a, **kw: None)
    monkeypatch.setattr(br, "get_ledger_signals", lambda **kw: [])
    monkeypatch.setattr(br, "record_signal", lambda **kw: False)
    monkeypatch.setattr(br, "ledger_stats", lambda: {"enabled": False})
    monkeypatch.setattr(br, "run_backtest_coordinated", br.run_backtest_coordinated, raising=False)
    for n in ("1", "2", "3"):
        monkeypatch.setenv(f"APP{n}_CANDLE_OFFSET", "0")
    return asyncio.run(br.run_backtest())


def test_backtest_does_not_double_count_hist_plus_live_duplicates(monkeypatch):
    from app.signal_ledger import reset_ledger_for_tests

    reset_ledger_for_tests()
    now = int(time.time())
    base = ((now // 60) - 5) * 60
    times = [base - i * 60 for i in range(3)]
    dup = times[0]
    hist = {"signals": [
        {"pair": "EURUSD_otc", "direction": "CALL", "ctime": t, "result": "correct"}
        for t in times
    ]}
    live = {"signals": [{"pair": "EURUSD_otc", "direction": "CALL", "time": dup}]}

    r = _run_backtest_with_monkey(monkeypatch, {"signals": []}, hist, live)

    assert r["totalSignals"] == 3, (
        f"expected 3 unique app3 signals, got {r['totalSignals']} "
        "(hist+live duplicate double-counted)"
    )
    assert r["sources"]["app3"]["total"] == 3
    assert r["sources"]["app3"]["win"] == 3
    assert r["sources"]["app3"]["unknown"] == 0
    assert r["totalClusters"] == 3


def test_backtest_resolves_hist_row_over_live_duplicate(monkeypatch):
    """When both a resolved hist row and an unresolved live row describe the
    same candle, the RESOLVED one must win (the aggregator's merge rule)."""
    from app.signal_ledger import reset_ledger_for_tests

    reset_ledger_for_tests()
    now = int(time.time())
    t = ((now // 60) - 3) * 60
    hist = {"signals": [{"pair": "EURUSD_otc", "direction": "CALL", "ctime": t, "result": "wrong"}]}
    live = {"signals": [{"pair": "EURUSD_otc", "direction": "CALL", "time": t}]}

    r = _run_backtest_with_monkey(monkeypatch, {"signals": []}, hist, live)

    assert r["totalSignals"] == 1
    assert r["sources"]["app3"]["win"] == 0
    assert r["sources"]["app3"]["loss"] == 1


# ---------------------------------------------------------------------------
# FIX 3 — the backtest's App 1 envelope tolerance missed "history", so a
# {"history": [...]} upstream change zeroed the backtest while the live
# aggregator (which checks "history" first) kept working.
# ---------------------------------------------------------------------------

def test_backtest_accepts_history_envelope_for_app1(monkeypatch):
    from app.signal_ledger import reset_ledger_for_tests

    reset_ledger_for_tests()
    now = int(time.time())
    t = ((now // 60) - 3) * 60
    app1_hist_env = {"history": [
        {"pair": "EURUSD_otc", "direction": "CALL", "entry_ts": t},
        {"pair": "EURUSD_otc", "direction": "CALL", "entry_ts": t - 60},
    ]}
    # The dangerous shape: "signals" exists but is EMPTY, so pick_array's
    # fallback-to-any-array must not stop at the empty "signals" list.
    app1_hist_env["signals"] = []

    r = _run_backtest_with_monkey(monkeypatch, app1_hist_env, {"signals": []}, {"signals": []})

    assert r["sources"]["app1"]["total"] == 2, (
        "backtest dropped App 1 rows wrapped in a {'history': [...]} envelope"
    )


# ---------------------------------------------------------------------------
# FIX 4 — a wedged backtest refresh's `finally` clobbered
# refresh_in_progress back to False AFTER the replacement task set it
# True, letting concurrent run_backtest() runs race on the cache.
# ---------------------------------------------------------------------------

def test_wedged_refresh_finally_does_not_clobber_replacement_flag():
    from app import backtest_runner as _br

    async def run():
        c = _br._get_cache()
        old_result = c.result
        old_fetched = c.fetched_at
        old_in_progress = c.refresh_in_progress

        async def never_completes():
            await asyncio.sleep(10000)

        wedged = asyncio.create_task(never_completes())
        c.refresh_in_progress = True
        c.refresh_task = wedged
        c.refresh_started_at = time.time() - 2 * _br.REFRESH_STUCK_SEC

        async def fake_run_backtest():
            return {"ok": True}

        orig = _br.run_backtest
        _br.run_backtest = fake_run_backtest
        try:
            new_task = _br._ensure_refresh_task()
            assert new_task is not wedged
            # Let the wedged task actually process its CancelledError and
            # run its finally block, and let the replacement finish.
            await asyncio.sleep(0.05)
            # OLD behaviour: the wedged task's finally had already cleared
            # the flag while the replacement was still running.
            assert not c.refresh_in_progress or new_task.done()
            assert c.refresh_task is new_task
            await new_task
            assert c.refresh_in_progress is False
            assert c.result == {"ok": True}
        finally:
            _br.run_backtest = orig
            wedged.cancel()
            c.result = old_result
            c.fetched_at = old_fetched
            c.refresh_in_progress = old_in_progress
            c.refresh_task = None

    asyncio.run(run())


# ---------------------------------------------------------------------------
# FIX 5 — a malformed row in data/app2_cache.json (missing captured_at, or
# candle_time as a string) crashed the disk-cache load with a TypeError
# that escaped the constructor's except, poisoning the first poll after boot.
# ---------------------------------------------------------------------------

@pytest.fixture
def app2_sandbox(tmp_path):
    """Swap the app2 cache's global singleton for a pristine one backed by
    a per-test disk file, and restore the original afterwards — these tests
    must not leak entries into the shared state (observed: the disk
    roundtrip test in test_regression_fixes loaded 3 entries instead of 1).
    """
    old_state = app2_cache._state
    app2_cache._state = None
    st = app2_cache._get_state()
    st.disk_path = str(tmp_path / "app2_cache.json")
    yield st
    app2_cache._state = old_state


def _write_rows(st, rows):
    st.disk_path and os.makedirs(os.path.dirname(st.disk_path), exist_ok=True)
    with open(st.disk_path, "w", encoding="utf-8") as f:
        json.dump(rows, f)


def test_app2_disk_load_survives_missing_captured_at(app2_sandbox):
    st = app2_sandbox
    _write_rows(st, [
        {"pair": "EURUSD_otc", "signal": "CALL", "candle_time": 1700000000},
    ])
    app2_cache._load_disk_cache(st)  # must not raise
    assert app2_cache.get_app2_cache_size() == 0  # row rejected, not crashed


def test_app2_disk_load_survives_string_candle_time(app2_sandbox):
    st = app2_sandbox
    _write_rows(st, [
        {"pair": "EURUSD_otc", "signal": "CALL", "candle_time": "1700000000",
         "captured_at": 1700000000000},
    ])
    app2_cache._load_disk_cache(st)  # must not raise
    assert app2_cache.get_app2_cache_size() == 0


def test_app2_disk_load_still_loads_valid_rows(app2_sandbox):
    st = app2_sandbox
    now_ms = time.time() * 1000
    _write_rows(st, [
        {"pair": "EURUSD_otc", "signal": "CALL", "candle_time": 1700000000,
         "captured_at": now_ms, "first_seen_sec": 1700000000},
        {"pair": "GBPUSD_otc", "signal": "PUT", "candle_time": 1700000060,
         "captured_at": now_ms, "first_seen_sec": 1700000060},
    ])
    app2_cache._load_disk_cache(st)
    assert app2_cache.get_app2_cache_size() == 2


# ---------------------------------------------------------------------------
# FIX 6/7 — refresh_candles() and poll_app2_now() now WAIT for an
# in-flight fetch/poll instead of silently returning with stale state.
# ---------------------------------------------------------------------------

def test_refresh_candles_waits_for_in_flight_fetch(monkeypatch):
    st = candle_fetcher._get_state()
    candle_fetcher.reset_candle_cache_for_tests()

    started = asyncio.Event()
    release = asyncio.Event()
    # A RECENT candle (now-2min) — anything older is pruned immediately by
    # MAX_CANDLE_AGE_SEC.
    ct = (int(time.time()) // 60 - 2) * 60

    async def slow_fetch(url, timeout=10.0, **kw):
        started.set()
        await release.wait()
        # One historical candle for the test pair.
        return {"signals": [{
            "asset": "EURUSD_otc", "ctime": ct, "signal": "CALL",
            "a_open": 1.0, "a_close": 1.5,
        }]}

    monkeypatch.setattr(candle_fetcher, "fetch_json_with_timeout", slow_fetch)

    async def run():
        first = asyncio.create_task(candle_fetcher.refresh_candles())
        await started.wait()
        # While `first` is mid-fetch, a second caller must WAIT, not return.
        second = asyncio.create_task(candle_fetcher.refresh_candles())
        await asyncio.sleep(0.05)
        assert st.fetch_in_progress is True
        release.set()
        await first
        await second  # returns only after the fetch completed
        # Both callers observe the fetched candle.
        c = candle_fetcher.get_candle("EURUSD_otc", ct)
        assert c is not None and c.close == 1.5

    asyncio.run(run())
    candle_fetcher.reset_candle_cache_for_tests()


def test_poll_app2_now_waits_for_in_flight_poll(app2_sandbox, monkeypatch):
    st = app2_sandbox

    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_fetch(url, timeout=8.0, **kw):
        started.set()
        await release.wait()
        return {"rows": [{"pair": "EURUSD_otc", "signal": "CALL", "time": "12:00"}],
                "timestamp": int(time.time())}

    monkeypatch.setattr(app2_cache, "fetch_json_with_timeout", slow_fetch)

    async def run():
        first = asyncio.create_task(app2_cache._poll_app2())
        await started.wait()
        second = asyncio.create_task(app2_cache.poll_app2_now())
        await asyncio.sleep(0.05)
        release.set()
        await first
        await second
        # The second caller must see the poll COMPLETED (last_poll_at set,
        # entries stored) — the old code returned immediately with none.
        assert st.last_poll_at > 0
        assert app2_cache.get_app2_cache_size() >= 1

    asyncio.run(run())


# ---------------------------------------------------------------------------
# FIX 8 — _serialize_candle now exposes isFinal so the UI can tell a final
# close from a mid-candle capture price.
# ---------------------------------------------------------------------------

def test_serialize_candle_exposes_is_final():
    from app.api.routes import _serialize_candle
    from app.candle_fetcher import Candle

    live = Candle(pair="EURUSD_otc", candle_time=1700000000, open=1.0, high=1.2,
                  low=0.9, close=1.05, result=None, app3_direction="CALL",
                  fetched_at=1700000005000, is_final=False)
    hist = Candle(pair="EURUSD_otc", candle_time=1700000000, open=1.0, high=1.2,
                  low=0.9, close=1.10, result="correct", app3_direction="CALL",
                  fetched_at=1700000060000, is_final=True)

    assert _serialize_candle(live)["isFinal"] is False
    assert _serialize_candle(hist)["isFinal"] is True


# ---------------------------------------------------------------------------
# FIX — app3's "history endpoint failed but live is fine" state now carries
# a human-readable detail instead of a bare disconnected health.
# ---------------------------------------------------------------------------

def test_app3_hist_failure_sets_detail():
    from app.signal_aggregator import NormalizeResult, fetch_app3
    import app.signal_aggregator as sa

    async def failing_fetch(url, timeout=10.0, **kw):
        if "share-signals" in url:
            return {"signals": [{"asset": "EURUSD_otc", "signal": "CALL",
                                 "time": int(time.time())}]}
        raise ConnectionError("history endpoint down")

    orig = sa.fetch_json_with_timeout
    sa.fetch_json_with_timeout = failing_fetch
    try:
        res = asyncio.run(fetch_app3(600, int(time.time())))
        assert isinstance(res, NormalizeResult)
        assert res.error == "hist_fetch_failed"
        assert res.detail and "history" in res.detail.lower()
    finally:
        sa.fetch_json_with_timeout = orig


# ---------------------------------------------------------------------------
# FIX — App 2 skip counters now separate "no direction" from "no candle".
# ---------------------------------------------------------------------------

def test_app2_skip_reasons_distinguish_no_candle():
    import app.signal_aggregator as sa

    rows = [
        {"pair": "EURUSD_otc", "signal": "CALL", "time": "—"},          # no candle
        {"pair": "GBPUSD_otc", "signal": "NEUTRAL", "time": "12:00"},   # no direction
        {"signal": "CALL", "time": "12:00"},                             # no pair
    ]

    async def fake_fetch(url, timeout=10.0, **kw):
        return {"rows": rows, "timestamp": int(time.time())}

    async def noop():
        return None

    orig_fetch, orig_start = sa.fetch_json_with_timeout, sa.start_app2_cache_poller
    orig_record = sa.record_app2_signals
    sa.fetch_json_with_timeout = fake_fetch
    sa.start_app2_cache_poller = lambda: None
    sa.record_app2_signals = lambda entries: None
    try:
        res = asyncio.run(sa.fetch_app2(600, int(time.time())))
        assert res.skipped.get("noPair") == 1
        assert res.skipped.get("noDirection") == 1
        assert res.skipped.get("noCandle", 0) == 1, (
            "an unparseable time field must be counted as noCandle, not noDirection"
        )
    finally:
        sa.fetch_json_with_timeout = orig_fetch
        sa.start_app2_cache_poller = orig_start
        sa.record_app2_signals = orig_record


# ---------------------------------------------------------------------------
# Frontend fixes — static checks on dashboard.js / dashboard.css, in the
# same style as test_ui_consistency.py.
# ---------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_PATH = os.path.join(ROOT, "app", "static", "dashboard.js")
CSS_PATH = os.path.join(ROOT, "app", "static", "dashboard.css")


@pytest.fixture(scope="module")
def js() -> str:
    return open(JS_PATH, encoding="utf-8").read()


@pytest.fixture(scope="module")
def js_code(js) -> str:
    """JS with // line comments stripped — so explanatory comments that
    QUOTE an old buggy pattern don't trip the 'old pattern must be gone'
    checks."""
    return "\n".join(
        re.sub(r"\s*//.*$", "", line) for line in js.splitlines()
    )


@pytest.fixture(scope="module")
def css() -> str:
    return open(CSS_PATH, encoding="utf-8").read()


def test_backtest_win_rate_no_dash_percent(js, js_code):
    """A zero-graded bucket must render a bare em-dash, never '—%'."""
    # The old pattern was `${winRate}%` where winRate could be "—".
    assert "`${winRate}%`" not in js_code
    # Every percent-text interpolation must sit behind a null guard
    # ("graded ?" / "wr == null ?") — fmtWr() is the canonical one.
    for m in re.finditer(r"\$\{[^}]*\.toFixed\(1\)\}%`", js_code):
        frag = js_code[max(0, m.start() - 200):m.start()]
        guarded = (
            re.search(r"== null \? ", frag)
            or re.search(r"graded \?", frag)
            or re.search(r"graded\s*\?\s*Number", frag)
        )
        assert guarded, f"unguarded toFixed(1)+% interpolation near: {m.group(0)[:60]}"


def test_app_cards_escape_upstream_text(js):
    """App status card title/detail must be escaped — `detail` is
    free-form upstream error text."""
    m = re.search(r"function renderAppCards\(apps\) \{.*?\n\}", js, re.S)
    assert m, "renderAppCards not found"
    body = m.group(0)
    assert "${escHtml(a.name)}" in body
    assert "${escHtml(a.detail" in body


def test_out_of_order_guard_exists(js):
    """The async-render ticket guard must exist and be used by the views
    that had out-of-order response races."""
    assert "function nextTicket(" in js
    assert "function ticketCurrent(" in js
    for slot in ("livewr", "sphistory", "histlist", "drawer"):
        assert f'"{slot}"' in js, f"ticket guard not wired for {slot}"


def test_drawer_fav_keeps_the_same_pair(js):
    """Toggling ☆ in the pair drawer must re-render the SAME pair's
    drawer (state.drawerData), not drop back to a loading state."""
    m = re.search(r'\$\("drawer-fav"\)\?\.addEventListener[\s\S]*?\n  \}\);', js)
    assert m, "drawer fav handler not found"
    assert "state.drawerData" in m.group(0), (
        "fav toggle must re-render from state.drawerData"
    )


def test_home_backtest_placeholder_translated(js):
    """The Home backtest placeholder must go through t() — the key exists
    in both translation tables."""
    assert 't("placeholder_run_backtest_home")' in js


def test_missing_css_classes_now_defined(css):
    for cls in (
        "placeholder--error",
        "hist-detail__verdict--pending",
        "drawer-tab--active",
        "hist-app-card--silent",
        "wr--none",
    ):
        assert f".{cls}" in css, f"CSS rule for .{cls} is missing"


def test_hero_cards_set_the_level_filter_select(js):
    """Hero-card jump must set the native #filter-level <select> (whose
    option labels are translated by data-i18n), never write a raw internal
    level value into any visible label."""
    m = re.search(r'\$\$\("\[data-hero-level\]"\)[\s\S]*?\}\);', js)
    assert m, "hero card wiring not found"
    body = m.group(0)
    assert '$("filter-level").value' in body
    assert "textContent" not in body


def test_win_rate_cards_filter_or_navigate(js):
    """The Signals win-rate cards: 3-agree/2-agree filter the table,
    combination cards navigate to the History list for that subset."""
    fn = js.split("function renderLiveWrPanel() {")[1].split("\n}", 1)[0]
    assert 'data-wrcard=' in fn or "data-wrcard" in fn
    assert '"3-agree"' in fn and '"2-agree"' in fn
    assert "#/history/" in fn


def test_drawer_history_running_win_rate_scoped_to_active_tab(js):
    """The drawer's running win rate must be computed over the ACTIVE
    tab's filtered rows (oldest→newest), not the unfiltered history."""
    fn = js.split("function renderDrawerHtml(data) {")[1].split("\n}", 1)[0]
    assert "activeDef.match" in fn, "rows must be filtered by the active tab"
    assert "__runningWr" in fn


def test_single_fetch_for_live_win_rate(js):
    """Both the Signals cards and the History overall cards must read the
    ONE cached /api/live-winrate payload — no second endpoint, no
    divergent numbers."""
    assert js.count('"/api/live-winrate"') == 1
    assert "renderOverallWinRate();" in js.split("async function fetchLiveWinRate")[1].split("\n}", 1)[0]


def test_poll_table_repaints_only_on_change(js):
    """renderSignalFeed must skip the DOM write when the HTML didn't
    change — the adaptive poll refires every second during the burst
    window and a full rebuild every tick makes the feed flicker."""
    fn = js.split("function renderSignalFeed(items) {")[1].split("\n}", 1)[0]
    assert "state._feedHtml === html" in fn
