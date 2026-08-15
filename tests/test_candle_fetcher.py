"""Tests for the candle-fetcher's grading logic.

These don't hit the network — they verify that ``grade_signal_against_candle``
correctly classifies a signal as WIN/LOSS/DRAW based on the candle's open and
close prices, which is the core win-rate computation used by the backtest.
"""

from app.candle_fetcher import Candle, grade_signal_against_candle


def make_candle(open_: float, close: float, **kwargs) -> Candle:
    return Candle(
        pair="TEST",
        candle_time=1700000000,
        open=open_,
        close=close,
        high=kwargs.get("high"),
        low=kwargs.get("low"),
        result=kwargs.get("result"),
        app3_direction=kwargs.get("app3_direction"),
        fetched_at=kwargs.get("fetched_at", 0.0),
    )


def test_call_wins_when_close_greater():
    assert grade_signal_against_candle("CALL", make_candle(100, 101)) == "WIN"


def test_call_loses_when_close_less():
    assert grade_signal_against_candle("CALL", make_candle(101, 100)) == "LOSS"


def test_put_wins_when_close_less():
    assert grade_signal_against_candle("PUT", make_candle(101, 100)) == "WIN"


def test_put_loses_when_close_greater():
    assert grade_signal_against_candle("PUT", make_candle(100, 101)) == "LOSS"


def test_draw_when_close_equals_open():
    assert grade_signal_against_candle("CALL", make_candle(100, 100)) == "DRAW"
    assert grade_signal_against_candle("PUT", make_candle(100, 100)) == "DRAW"


def test_draw_when_within_epsilon():
    # 1e-12 is well below the 1e-9 epsilon; should be DRAW, not a tiny win.
    assert grade_signal_against_candle("CALL", make_candle(100, 100 + 1e-12)) == "DRAW"
    assert grade_signal_against_candle("PUT", make_candle(100, 100 - 1e-12)) == "DRAW"


def test_unknown_when_candle_is_null():
    assert grade_signal_against_candle("CALL", None) == "UNKNOWN"
    assert grade_signal_against_candle("PUT", None) == "UNKNOWN"


def test_unknown_when_close_is_nan():
    c = make_candle(100, float("nan"))
    assert grade_signal_against_candle("CALL", c) == "UNKNOWN"


def test_unknown_when_open_is_nan():
    c = make_candle(float("nan"), 100)
    assert grade_signal_against_candle("CALL", c) == "UNKNOWN"


def test_works_with_small_price_moves_forex():
    # USDCOP-like pair: open 3145.51, close 3145.39 — PUT signal wins.
    assert grade_signal_against_candle("PUT", make_candle(3145.51, 3145.39)) == "WIN"
    assert grade_signal_against_candle("CALL", make_candle(3145.51, 3145.39)) == "LOSS"


def test_works_with_large_price_values_jpy():
    # USDJPY-like pair: open 159.507, close 159.512 — CALL signal wins.
    assert grade_signal_against_candle("CALL", make_candle(159.507, 159.512)) == "WIN"
