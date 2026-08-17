"""Tests for the shared normalization helpers.

These mirror the original TypeScript tests in tests/signal-normalize.test.ts
and verify the same regression-causing behaviors:

- timestamps in milliseconds don't push the candle 53,000 years into the future
- all three apps' pair spellings collapse to one canonical key
- App 2's wall-clock string in a non-UTC timezone still aligns
- a signal emitted long after its candle closed is rejected as look-ahead
"""

from datetime import datetime, timezone

from app.signal_normalize import (
    canonical_pair,
    candle_floor,
    display_pair_from_asset,
    is_signal_valid_for_candle,
    parse_direction,
    pick_array,
    pick_field,
    resolve_clock_to_candle,
    to_unix_seconds,
)


def _utc(y, mo, d, h, mi, s=0):
    return int(datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp())


# ---- to_unix_seconds -----------------------------------------------------


def test_to_unix_seconds_passes_seconds_through():
    assert to_unix_seconds(1786000000) == 1786000000


def test_to_unix_seconds_converts_milliseconds():
    # This is the bug that put App 3 candles ~53,000 years in the future.
    assert to_unix_seconds(1786000000000) == 1786000000


def test_to_unix_seconds_converts_microseconds():
    assert to_unix_seconds(1786000000000000) == 1786000000


def test_to_unix_seconds_parses_numeric_strings_and_iso_dates():
    assert to_unix_seconds("1786000000") == 1786000000
    assert to_unix_seconds("2026-08-13T04:49:00Z") == _utc(2026, 8, 13, 4, 49)


def test_to_unix_seconds_returns_zero_for_junk():
    assert to_unix_seconds(None) == 0
    assert to_unix_seconds("") == 0
    assert to_unix_seconds("not a time") == 0
    assert to_unix_seconds(-5) == 0
    # bool is a subclass of int — guard explicitly
    assert to_unix_seconds(True) == 0
    assert to_unix_seconds(False) == 0


def test_to_unix_seconds_converts_nanoseconds():
    assert to_unix_seconds(1786000000000000000) == 1786000000


def test_to_unix_seconds_rejects_implausible_magnitude_instead_of_crashing():
    # A stray nanosecond-or-larger / garbage value must not "divide down"
    # into an out-of-range seconds value — datetime.fromtimestamp() raises
    # OSError/OverflowError on some platforms (observed on Windows) for
    # anything tens of thousands of years out, and every caller downstream
    # (candle bucketing, /api/snapshot, _fmt_hm/_fmt_hms) passes the result
    # straight to it.
    huge = to_unix_seconds(5e20)
    assert huge == 0
    from datetime import datetime, timezone as _tz
    # Sanity: every non-zero result this function can produce must be safe
    # to hand to fromtimestamp().
    for raw in (1786000000, 1786000000000, 1786000000000000, 1786000000000000000, 5e20, 9.99e30):
        v = to_unix_seconds(raw)
        if v > 0:
            datetime.fromtimestamp(v, tz=_tz.utc)  # must not raise


# ---- canonical_pair ------------------------------------------------------


def test_canonical_pair_all_spellings_collapse():
    expected = "USDCOP_otc"
    assert canonical_pair("USDCOP_otc") == expected
    assert canonical_pair("USDCOP-OTC") == expected
    assert canonical_pair("usdcop_otc") == expected
    assert canonical_pair("USD/COP OTC") == expected
    assert canonical_pair("USD/COP (OTC)") == expected
    assert canonical_pair("  USDCOP otc ") == expected


def test_canonical_pair_non_otc_keeps_no_suffix():
    assert canonical_pair("EURUSD") == "EURUSD"
    assert canonical_pair("EUR/USD") == "EURUSD"


def test_canonical_pair_otc_only_as_whole_word():
    # "OTCUSD" is a real ticker shape, not an OTC marker.
    assert canonical_pair("OTCUSD") == "OTCUSD"


def test_canonical_pair_rejects_unusable_input():
    assert canonical_pair(None) == ""
    assert canonical_pair("") == ""
    assert canonical_pair("///") == ""


# ---- display_pair_from_asset --------------------------------------------


def test_display_pair_splits_on_known_quote():
    assert display_pair_from_asset("USDCOP_otc") == "USD/COP OTC"
    assert display_pair_from_asset("EURUSD") == "EUR/USD"
    assert display_pair_from_asset("BTCUSDT") == "BTC/USDT"


def test_display_pair_does_not_mangle_unknown_names():
    # The old blind slice(0,3)/slice(3) produced "APP/LE".
    assert display_pair_from_asset("APPLE") == "APPLE"


# ---- resolve_clock_to_candle --------------------------------------------


REF = _utc(2026, 8, 13, 4, 49, 30)


def test_resolve_clock_uses_string_verbatim_when_utc():
    assert resolve_clock_to_candle("04:49", REF) == _utc(2026, 8, 13, 4, 49)


def test_resolve_clock_recovers_other_timezone():
    # App 2 rendering UTC+6 says "10:49" for the same candle.
    assert resolve_clock_to_candle("10:49", REF) == _utc(2026, 8, 13, 4, 49)
    # Same for a negative offset (broker time UTC-3).
    assert resolve_clock_to_candle("01:49", REF) == _utc(2026, 8, 13, 4, 49)


def test_resolve_clock_handles_midnight_wrap():
    midnight_ref = _utc(2026, 8, 13, 0, 0, 20)
    # "23:59" is the previous day's candle, not 24h in the future.
    assert resolve_clock_to_candle("23:59", midnight_ref) == _utc(2026, 8, 12, 23, 59)


def test_resolve_clock_falls_back_to_ref_for_junk():
    assert resolve_clock_to_candle("", REF) == _utc(2026, 8, 13, 4, 49)
    assert resolve_clock_to_candle("garbage", REF) == _utc(2026, 8, 13, 4, 49)
    assert resolve_clock_to_candle("99:99", REF) == _utc(2026, 8, 13, 4, 49)
    # UTC+5:30 renders "10:19" — 30 minutes off on the minute hand, which we
    # cannot recover.
    assert resolve_clock_to_candle("10:19", REF) == _utc(2026, 8, 13, 4, 49)


# ---- is_signal_valid_for_candle -----------------------------------------


CANDLE = _utc(2026, 8, 13, 4, 50)


def test_valid_for_candle_accepts_prediction_just_before():
    assert is_signal_valid_for_candle(CANDLE - 20, CANDLE) is True


def test_valid_for_candle_accepts_during_candle():
    assert is_signal_valid_for_candle(CANDLE + 30, CANDLE) is True


def test_valid_for_candle_rejects_look_ahead():
    assert is_signal_valid_for_candle(CANDLE + 600, CANDLE) is False


def test_valid_for_candle_rejects_absurdly_early():
    assert is_signal_valid_for_candle(CANDLE - 3600, CANDLE) is False


def test_valid_for_candle_trusts_bucket_when_no_timestamp():
    assert is_signal_valid_for_candle(0, CANDLE) is True


def test_valid_for_candle_stays_valid_for_old_candles():
    old_candle = CANDLE - 6 * 3600
    assert is_signal_valid_for_candle(old_candle - 10, old_candle) is True


# ---- shape tolerance ----------------------------------------------------


def test_pick_array_finds_payload():
    assert pick_array({"rows": [1, 2]}, ["rows", "signals"]) == [1, 2]
    assert pick_array({"signals": [1]}, ["rows", "signals"]) == [1]
    assert pick_array([3, 4], ["rows"]) == [3, 4]
    assert pick_array({"data": [{"a": 1}]}, ["rows", "signals"]) == [{"a": 1}]
    assert pick_array(None, ["rows"]) == []


def test_pick_field_skips_empty():
    assert pick_field({"a": "", "b": "x"}, ["a", "b"]) == "x"
    assert pick_field({"a": None, "b": 0}, ["a", "b"]) == 0
    assert pick_field(None, ["a"]) is None


def test_parse_direction_normalizes_synonyms():
    assert parse_direction("call") == "CALL"
    assert parse_direction(" BUY ") == "CALL"
    assert parse_direction("PUT") == "PUT"
    assert parse_direction("down") == "PUT"
    assert parse_direction("NEUTRAL") is None
    assert parse_direction("—") is None
    assert parse_direction(None) is None


# ---- candle_floor -------------------------------------------------------


def test_candle_floor_floors_to_minute():
    assert candle_floor(1786430999) == 1786430940
    assert candle_floor(0) == 0
