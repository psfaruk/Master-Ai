"""Regression tests for the APPx_CANDLE_OFFSET / is_signal_valid_for_candle bug.

APPx_CANDLE_OFFSET exists purely to shift which candle BUCKET a signal joins
for cross-app consensus (see get_candle_offset_sec's docstring) — it says
nothing about whether the signal was emitted at a sane time relative to what
it predicts. Validating "is this a legitimate signal for its candle" against
the OFFSET-SHIFTED candle_time instead of the raw one meant a negative offset
(a supported, documented value — /api/diag's own hint text recommends
setting one) pushed `lead` past -MAX_LAG_SEC and silently marked every one of
that app's signals invalid, dropping the whole app from consensus/backtest —
the exact opposite of what setting the offset was supposed to fix.
"""

from __future__ import annotations

from app.backtest_runner import normalize_app1, normalize_app3
from app.signal_aggregator import _make_signal
from app.signal_normalize import is_signal_valid_for_candle

CANDLE = 1_800_000_000  # arbitrary, minute-aligned


def test_normalize_app1_raw_candle_time_survives_negative_offset(monkeypatch):
    monkeypatch.setenv("APP1_CANDLE_OFFSET", "-2")
    d = {
        "pair": "EURUSD",
        "direction": "CALL",
        "entry_ts": CANDLE,
        "created_at": CANDLE - 20,  # an ordinary "emitted 20s before open" prediction
    }
    sig = normalize_app1(d)
    assert sig is not None
    assert sig.raw_candle_time == CANDLE
    assert sig.candle_time == CANDLE - 120

    # The bug: validating against the offset-shifted candle_time makes this
    # perfectly ordinary signal look invalid.
    assert is_signal_valid_for_candle(sig.ts, sig.candle_time) is False
    # The fix: run_backtest()'s push() validates against raw_candle_time.
    assert is_signal_valid_for_candle(sig.ts, sig.raw_candle_time) is True


def test_normalize_app3_raw_candle_time_survives_negative_offset(monkeypatch):
    monkeypatch.setenv("APP3_CANDLE_OFFSET", "-3")
    d = {"asset": "GBPUSD", "signal": "PUT", "ctime": CANDLE}
    sig = normalize_app3(d, ["ctime"])
    assert sig is not None
    assert sig.raw_candle_time == CANDLE
    assert sig.candle_time == CANDLE - 180
    # App3's ts is the raw emission time itself (no created_at fallback),
    # so with no offset correction this would also be marked invalid.
    assert is_signal_valid_for_candle(sig.ts, sig.candle_time) is False
    assert is_signal_valid_for_candle(sig.ts, sig.raw_candle_time) is True


def test_aggregator_make_signal_valid_for_candle_uses_raw_candle_time():
    """signal_aggregator._make_signal must grade validity against
    raw_candle_time (when supplied), not the offset-shifted candle_time —
    otherwise the live dashboard (not just the backtest) silently drops an
    app from consensus the moment a candle offset is configured."""
    base = {
        "source": "app1",
        "source_name": "Minimum Pair",
        "pair": "EURUSD",
        "direction": "CALL",
        "timestamp": CANDLE - 20,
        "candle_time": CANDLE - 120,  # shifted by a -2 candle offset
        "raw_candle_time": CANDLE,
    }
    sig = _make_signal(base, now=CANDLE, freshness_window_sec=1800)
    assert sig.valid_for_candle is True

    # Without raw_candle_time (callers that predate the fix / offset == 0),
    # behavior for the zero-offset case stays identical to before.
    base_no_offset = dict(base, candle_time=CANDLE)
    del base_no_offset["raw_candle_time"]
    sig2 = _make_signal(base_no_offset, now=CANDLE, freshness_window_sec=1800)
    assert sig2.valid_for_candle is True
