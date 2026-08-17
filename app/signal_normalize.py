"""Shared normalization helpers.

Every module that reads the three source apps (aggregator, app2-cache,
backtest-runner) MUST go through these helpers. The original TypeScript code
had three classes of cross-app alignment bug that lived here:

1. Pair keys — App 1 says `symbol`, App 2 says `pair`, App 3 says `asset`, and
   they do not always use the same spelling ("USDCOP_otc" vs "USDCOP-OTC" vs
   "USD/COP OTC"). Consensus is a dict lookup on that string, so any spelling
   drift silently drops an app from the group.

2. Timestamps — some fields are unix seconds, some are milliseconds, some are
   ISO strings. A millisecond value read as seconds lands the candle ~53,000
   years in the future, which both hides the signal and poisons "newest candle"
   selection for the whole pair.

3. Wall-clock strings — App 2 reports only "HH:MM". Parsing that as UTC is
   only correct if App 2 renders UTC; if it renders any other whole-hour
   timezone, every App 2 signal lands hours away from App 1 / App 3 and never
   joins a candle.

This module fixes all three.
"""

from __future__ import annotations

import math
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

# Seconds per candle. Everything in this project is 1-minute candles.
CANDLE_SEC = 60

# Field-name aliases, so a rename upstream doesn't blank out a column.
PAIR_KEYS = ("symbol", "pair", "asset", "instrument", "ticker")
DIRECTION_KEYS = ("direction", "signal", "side", "action", "type")

AppId = str  # "app1" | "app2" | "app3"
Direction = str  # "CALL" | "PUT" | "NEUTRAL"


# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------


# Upper bound for a plausible unix-seconds value (2100-01-01 UTC). Nothing
# in this app legitimately deals in timestamps anywhere near that far out —
# this exists purely to catch garbage. Values beyond it are rejected rather
# than returned, because `datetime.fromtimestamp()` (called all over the
# codebase — candle bucketing, `_fmt_hm`/`_fmt_hms`, `/api/diag`, etc.)
# raises OSError/OverflowError on out-of-range values on some platforms
# (observed on Windows), which would 500 whichever endpoint touched it.
_MAX_SANE_UNIX_SEC = 4_102_444_800


def to_unix_seconds(value: Any) -> int:
    """Coerce anything that looks like a timestamp into unix SECONDS.

    Accepts unix seconds, unix milliseconds, unix microseconds, unix
    nanoseconds, numeric strings and ISO-8601 strings. Returns 0 when the
    value is missing, unparseable, or resolves to an implausible magnitude
    (garbage / an unrecognized unit), so callers can test with a simple
    ``> 0`` and safely pass the result straight to
    ``datetime.fromtimestamp()``.
    """
    if value is None:
        return 0

    if isinstance(value, bool):  # bool is a subclass of int — guard explicitly
        return 0

    if isinstance(value, (int, float)):
        n = value
    elif isinstance(value, str):
        s = value.strip()
        if not s:
            return 0
        try:
            n = float(s) if ("." in s or "e" in s.lower()) else int(s)
        except ValueError:
            # Not numeric — try to parse as an ISO date string.
            try:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            except ValueError:
                return 0
            result = int(dt.timestamp())
            return result if 0 < result <= _MAX_SANE_UNIX_SEC else 0
    else:
        return 0

    if not math.isfinite(n) or n <= 0:
        return 0

    # Magnitude test. A sane unix-seconds timestamp for "now" is ~1.7e9.
    if n >= 1e17:  # nanoseconds
        result = int(n // 1_000_000_000)
    elif n >= 1e14:  # microseconds
        result = int(n // 1_000_000)
    elif n >= 1e11:  # milliseconds
        result = int(n // 1000)
    else:
        result = int(n)

    # A value whose unit this function didn't recognize (or that was just
    # garbage to begin with) can still come out absurdly large even after
    # unit correction — e.g. a stray 1e18 "divides down" to ~31,700 years
    # via the microsecond branch alone. Reject it outright rather than
    # letting a 50,000-years-in-the-future timestamp leak downstream.
    return result if result <= _MAX_SANE_UNIX_SEC else 0


def candle_floor(ts_sec: int) -> int:
    """Floor a unix-seconds timestamp to the start of its 1-minute candle."""
    if ts_sec is None or ts_sec <= 0:
        return 0
    return (ts_sec // CANDLE_SEC) * CANDLE_SEC


def resolve_clock_to_candle(time_str: str, ref_sec: int, max_drift_sec: int = 90 * 60) -> int:
    """Resolve a wall-clock string ("HH:MM" or "HH:MM:SS") into a unix-seconds
    candle time.

    Uses ``ref_sec`` (a trustworthy absolute time, e.g. the upstream server
    timestamp or our own clock) to pin down the date AND the timezone.

    Strategy, in order:

    1. Interpret the string as UTC on ref's date (± a day for wrap-around).
       If that lands within ``max_drift_sec`` of ref, App 2 really is emitting
       UTC and we use it verbatim.
    2. Otherwise assume the source renders some other whole-hour timezone. The
       MINUTE is timezone-independent for whole-hour offsets, so pick the
       instant nearest to ref whose minute-of-hour matches. That recovers the
       correct candle without knowing which timezone the app uses.
    3. If even that is implausible, fall back to ref's own candle. For a live
       snapshot — which is the only thing App 2 exposes — ref's candle is the
       right answer.
    """
    ref_candle = candle_floor(ref_sec)
    if not time_str:
        return ref_candle

    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", time_str.strip())
    if not m:
        return ref_candle

    hh = int(m.group(1))
    mm = int(m.group(2))
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return ref_candle

    # --- 1. Try a literal UTC reading, allowing day wrap in both directions.
    ref_dt = datetime.fromtimestamp(ref_sec, tz=timezone.utc)
    same_day_utc = int(
        datetime(
            ref_dt.year, ref_dt.month, ref_dt.day, hh, mm, 0, tzinfo=timezone.utc
        ).timestamp()
    )
    utc_candidates = (same_day_utc - 86400, same_day_utc, same_day_utc + 86400)
    best_utc = min(utc_candidates, key=lambda c: abs(c - ref_sec))
    if abs(best_utc - ref_sec) <= max_drift_sec:
        return candle_floor(best_utc)

    # --- 2. Timezone-agnostic recovery: match on minute-of-hour only.
    ref_minute_of_hour = ref_dt.minute
    delta_min = mm - ref_minute_of_hour
    # Wrap into [-30, 30) so we pick the nearest matching minute.
    if delta_min >= 30:
        delta_min -= 60
    if delta_min < -30:
        delta_min += 60
    nearest = ref_candle + delta_min * 60
    if abs(nearest - ref_sec) <= 5 * 60:
        return candle_floor(nearest)

    # --- 3. Give up on the string; the reference clock is more reliable.
    return ref_candle


# ---------------------------------------------------------------------------
# Pair identity
# ---------------------------------------------------------------------------

# Matches an "otc" marker that is delimited by a separator (or the string edge)
# on both sides. A plain ``\\botc\\b`` is not enough here: ``_`` is a word
# character, so it never matched the most common spelling of all, "USDCOP_otc".
_OTC_RE = re.compile(r"(^|[\s_\-()/])otc(?=$|[\s_\-()/])", re.IGNORECASE)


def canonical_pair(raw: Any) -> str:
    """Canonical pair key, shared by all 3 apps.

    Uppercase alphanumerics plus an ``_otc`` suffix for OTC assets.

        "USDCOP_otc"  -> "USDCOP_otc"
        "USD/COP OTC" -> "USDCOP_otc"
        "usdcop-otc"  -> "USDCOP_otc"
        "EURUSD"      -> "EURUSD"

    Returns ``""`` for unusable input so callers can skip the row.
    """
    if not isinstance(raw, str):
        return ""
    s = raw.strip()
    if not s:
        return ""

    is_otc = bool(_OTC_RE.search(s))
    base = _OTC_RE.sub("", s)
    base = re.sub(r"[^A-Za-z0-9]", "", base).upper()
    if not base:
        return ""
    return f"{base}_otc" if is_otc else base


def is_otc_pair(canonical: str) -> bool:
    return canonical.endswith("_otc")


def classify_pair(canonical: str) -> str:
    """``"otc"`` or ``"real"``."""
    return "otc" if is_otc_pair(canonical) else "real"


# Quote currencies we know about, longest first so "USDT" beats "USD".
_QUOTES = (
    "USDT", "USDC", "BUSD",
    "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD",
    "CNH", "CNY", "HKD", "SGD", "TRY", "ZAR", "MXN", "BRL", "INR", "RUB",
    "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "THB", "IDR", "PHP", "COP",
    "ARS", "CLP", "PEN", "EGP", "NGN", "PKR", "BDT", "VND", "KES", "SAR",
    "AED", "QAR", "MAD", "DZD", "TND", "JOD", "BHD", "KWD", "OMR", "LBP",
)


def display_pair_from_asset(canonical: str) -> str:
    """Human-readable display form of a canonical pair.

        "USDCOP_otc" -> "USD/COP OTC"
        "BTCUSDT"    -> "BTC/USDT"
        "APPLE"      -> "APPLE"   (no known split — left alone rather than
                                    blindly cut at 3 chars, which used to
                                    produce nonsense like "APP/LE")
    """
    otc = is_otc_pair(canonical)
    base = canonical[:-4] if otc else canonical
    suffix = " OTC" if otc else ""

    for q in _QUOTES:
        if len(base) > len(q) and base.endswith(q):
            return f"{base[:-len(q)]}/{q}{suffix}"

    # Classic 6-letter forex code with an unknown quote — split down the middle.
    if len(base) == 6:
        return f"{base[:3]}/{base[3:]}{suffix}"
    return f"{base}{suffix}"


# ---------------------------------------------------------------------------
# Shape tolerance
# ---------------------------------------------------------------------------


def pick_array(data: Any, keys: Iterable[str]) -> list:
    """Pull the signal array out of a response whose envelope key we are not
    sure about.

    The source apps have changed their envelope before (``rows`` vs
    ``signals`` vs a bare array); when that happens the old code silently
    produced zero signals for that app and the dashboard just showed an empty
    column.
    """
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for k in keys:
        v = data.get(k)
        if isinstance(v, list):
            return v
    # Last resort: any top-level array-of-objects property.
    for v in data.values():
        if isinstance(v, list) and v and isinstance(v[0], dict):
            return v
    return []


def pick_field(row: Any, keys: Iterable[str]) -> Any:
    """First non-null/non-empty value among the given keys of ``row``."""
    if not isinstance(row, dict):
        return None
    for k in keys:
        v = row.get(k)
        if v is not None and v != "":
            return v
    return None


def parse_direction(raw: Any) -> Optional[str]:
    """Normalize a direction string; returns ``None`` when it isn't CALL/PUT."""
    if raw is None:
        return None
    s = str(raw).strip().upper()
    if s in ("CALL", "BUY", "UP", "LONG"):
        return "CALL"
    if s in ("PUT", "SELL", "DOWN", "SHORT"):
        return "PUT"
    return None


# ---------------------------------------------------------------------------
# Candle alignment
# ---------------------------------------------------------------------------


def get_candle_offset_sec(app: AppId) -> int:
    """Per-app candle offset, in whole candles, applied when bucketing a signal.

    The three apps do not all label a signal with the same candle: one may tag
    the candle it just analysed while another tags the candle it is predicting.
    When that happens the apps sit in adjacent buckets and can never agree.

    Defaults are 0 (no shift) — set these only if ``/api/diag`` reports a
    consistent non-zero offset between two apps::

        APP1_CANDLE_OFFSET=0   (candles, e.g. "-1")
        APP2_CANDLE_OFFSET=0
        APP3_CANDLE_OFFSET=0
    """
    key = f"{app.upper()}_CANDLE_OFFSET"
    raw = os.environ.get(key)
    if not raw:
        return 0
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return 0
    # Clamp to ±5 candles — anything larger is a misconfiguration, not an offset.
    clamped = max(-5, min(5, n))
    return clamped * CANDLE_SEC


# How early a signal may be emitted and still count for its candle.
MAX_LEAD_SEC = 5 * 60
# How late (after the candle opened) a signal may be emitted and still count.
MAX_LAG_SEC = CANDLE_SEC + 30


def is_signal_valid_for_candle(timestamp_sec: int, candle_time: int) -> bool:
    """Is this signal legitimately about ``candle_time``?

    A signal counts for a candle when it was emitted shortly before that candle
    (a prediction) or during it — not after it closed, which would be
    look-ahead. This replaces the old "is the signal younger than N minutes
    relative to NOW" test, which was wrong for candle-aligned consensus: it
    threw away every historical candle's signals and made the candle-history
    table permanently empty.
    """
    if not (candle_time and candle_time > 0):
        return False
    # A missing/zero timestamp means the source didn't tell us when it emitted;
    # trust the candle bucket itself rather than dropping the signal.
    if not (timestamp_sec and timestamp_sec > 0):
        return True
    lead = candle_time - timestamp_sec
    # lead > 0  : emitted before the candle opened (a prediction) — allow up to MAX_LEAD_SEC.
    # lead <= 0 : emitted during the candle — allow until shortly after it closed.
    return lead <= MAX_LEAD_SEC and lead >= -MAX_LAG_SEC


def now_sec() -> int:
    """Current wall-clock time in unix seconds."""
    return int(time.time())
