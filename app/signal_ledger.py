"""Unified signal ledger — durable history for ALL three source apps.

Why this exists
---------------
Before this module the backtest's history depth was capped by whatever the
upstream apps happened to return *at that moment*:

===== =========================================== ==================
App   History source                              Effective depth
===== =========================================== ==================
1     ``/api/history?limit=5000``                 ~4.75 h
2     no history endpoint at all                  our own poller only
3     ``/api/signals?limit=500`` (hard 500 cap)   **~41 minutes**
===== =========================================== ==================

App 3 caps at 500 rows regardless of the requested limit, so for every
candle older than ~41 minutes App 3 looked *absent*. A candle where all
three apps actually agreed was therefore silently downgraded to
``2-agree`` (or ``1-only``) once it aged past that window — which is
exactly the "App 1/2/3 merge korle signal gulo thik moto save hocche na"
symptom: the 3-agree history was sparse and the per-level win rates were
computed against a distorted population.

App 2 already had a disk-backed poller cache. This module generalises that
idea to **all three apps**: every normalized signal we ever observe is
written to a local, disk-persisted ledger keyed by
``(source, pair, candle_time)``. History depth then becomes a function of
*our* uptime and retention window instead of the upstream's page cap, and
it survives process restarts / Railway redeploys.

Design notes
------------
- **Idempotent**: re-recording the same ``(source, pair, candle_time)`` keeps
  the earliest ``first_seen_sec`` (that is the honest emission time) but
  upgrades ``outcome`` / ``candle_outcome`` from ``None`` to a real verdict.
  Re-reading the same upstream row every poll therefore does not corrupt
  timing or double-count.
- **Bounded**: entries older than the retention window are pruned on load,
  on save, and on read, so the JSON file cannot grow without limit.
- **Fail-soft**: a malformed or half-written file is logged and ignored
  rather than raised — a bad ledger must never take the backtest down.
- **Off by default**: ``disk_path`` is ``None`` until :func:`activate_ledger`
  is called, so unit tests get a clean in-memory ledger with no stray
  files. ``run_backtest()`` activates it in production.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger("master-ai.signal_ledger")

# How long a signal stays in the ledger. 48h by default: comfortably more
# than the backtest's 6h lookback, so a redeploy or a few hours of downtime
# still leaves a full window of history behind.
DEFAULT_RETENTION_SEC = 48 * 3600

# Never write to disk more often than this (the backtest runs ~1×/min, but
# /api/backtest can be hit manually in a loop).
DISK_SAVE_MIN_INTERVAL_SEC = 20.0

# Hard ceiling on ledger size. Protects the container's disk if a pair
# explosion or a misbehaving upstream floods us. Oldest entries go first.
MAX_ENTRIES = 400_000


@dataclass
class LedgerEntry:
    """One app's opinion about one (pair, candle)."""

    source: str          # "app1" | "app2" | "app3"
    pair: str            # canonical pair key, e.g. "USDCOP_otc"
    candle_time: int     # unix seconds, minute-floored, offset APPLIED
    direction: str       # "CALL" | "PUT"
    first_seen_sec: int  # when the source app emitted it (unix seconds)
    raw_candle_time: int = 0        # candle_time BEFORE the per-app offset
    outcome: Optional[int] = None   # source app's own verdict: 1 win / 0 loss
    candle_outcome: Optional[int] = None  # verdict from the real candle close
    raw_status: Optional[str] = None
    recorded_at: float = 0.0        # local wall clock when we first saw it


# Fields that round-trip through the JSON file. Kept explicit (rather than
# asdict) so adding a runtime-only field later cannot silently change the
# on-disk schema.
_DISK_FIELDS: Tuple[str, ...] = (
    "source", "pair", "candle_time", "direction", "first_seen_sec",
    "raw_candle_time", "outcome", "candle_outcome", "raw_status",
    "recorded_at",
)

_VALID_SOURCES = frozenset({"app1", "app2", "app3"})
_VALID_DIRECTIONS = frozenset({"CALL", "PUT"})


@dataclass
class LedgerState:
    # (source, pair, candle_time) -> LedgerEntry
    entries: Dict[Tuple[str, str, int], LedgerEntry] = field(default_factory=dict)
    disk_path: Optional[str] = None   # None = persistence off
    retention_sec: int = DEFAULT_RETENTION_SEC
    dirty: bool = False
    last_disk_save_at: float = 0.0
    loaded_from_disk: bool = False
    # Counters surfaced by /api/diag so the depth problem is observable.
    stats: Dict[str, int] = field(default_factory=lambda: {
        "recorded": 0, "updated": 0, "skipped": 0, "pruned": 0, "restored": 0,
    })


_state: Optional[LedgerState] = None
# The backtest can run concurrently with the snapshot poller; both record.
_lock = threading.RLock()


def _get_state() -> LedgerState:
    global _state
    if _state is None:
        _state = LedgerState()
    return _state


def _default_disk_path() -> str:
    """JSON file the ledger is persisted to.

    Overridable via ``SIGNAL_LEDGER_FILE``. Defaults to
    ``<repo>/data/signal_ledger.json`` — same directory the App 2 cache
    already uses, which is writable in the Docker image.
    """
    env = os.environ.get("SIGNAL_LEDGER_FILE", "").strip()
    if env:
        return env
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "data", "signal_ledger.json")


def _retention_sec() -> int:
    raw = os.environ.get("SIGNAL_LEDGER_RETENTION_HOURS", "").strip()
    if raw:
        try:
            hours = float(raw)
            if hours > 0:
                return int(min(hours, 24 * 30) * 3600)
        except ValueError:
            logger.warning("[ledger] bad SIGNAL_LEDGER_RETENTION_HOURS=%r — using default", raw)
    return DEFAULT_RETENTION_SEC


# ---------------------------------------------------------------------------
# Disk persistence
# ---------------------------------------------------------------------------


def _load_disk(st: LedgerState) -> None:
    path = st.disk_path
    if not path or not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        logger.warning("[ledger] load failed (%s) — starting empty", e)
        return
    if not isinstance(raw, list):
        logger.warning("[ledger] unexpected file shape — ignoring")
        return

    cutoff = int(time.time()) - st.retention_sec
    restored = 0
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            entry = LedgerEntry(**{k: item.get(k) for k in _DISK_FIELDS})
        except TypeError:
            continue
        if not _is_valid(entry) or entry.candle_time < cutoff:
            continue
        st.entries[(entry.source, entry.pair, entry.candle_time)] = entry
        restored += 1
    st.stats["restored"] = restored
    st.loaded_from_disk = True
    if restored:
        logger.info("[ledger] restored %d signals from %s", restored, path)


def _save_disk(st: LedgerState, *, force: bool = False) -> None:
    """Atomically write the ledger (tmp file + os.replace)."""
    path = st.disk_path
    if not path or not st.dirty:
        return
    now = time.time()
    if not force and now - st.last_disk_save_at < DISK_SAVE_MIN_INTERVAL_SEC:
        return

    _prune(st)

    payload = [
        {k: getattr(e, k) for k in _DISK_FIELDS}
        for e in st.entries.values()
    ]
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        # Write to a temp file in the SAME directory so os.replace is atomic
        # (rename across filesystems is not).
        fd, tmp = tempfile.mkstemp(
            dir=os.path.dirname(path) or ".", prefix=".ledger-", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, separators=(",", ":"))
            os.replace(tmp, path)
        except BaseException:
            # Never leave a stray tmp file behind on failure.
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as e:
        logger.warning("[ledger] save failed: %s", e)
        return

    st.dirty = False
    st.last_disk_save_at = now
    logger.debug("[ledger] saved %d signals to %s", len(payload), path)


def _prune(st: LedgerState) -> None:
    """Drop entries past the retention window, then enforce MAX_ENTRIES."""
    cutoff = int(time.time()) - st.retention_sec
    pruned = 0
    for key, entry in list(st.entries.items()):
        if entry.candle_time < cutoff:
            st.entries.pop(key, None)
            pruned += 1
    if len(st.entries) > MAX_ENTRIES:
        # Oldest candles go first.
        ordered = sorted(st.entries.items(), key=lambda kv: kv[1].candle_time)
        for key, _ in ordered[: len(st.entries) - MAX_ENTRIES]:
            st.entries.pop(key, None)
            pruned += 1
    if pruned:
        st.stats["pruned"] += pruned


def _is_valid(entry: LedgerEntry) -> bool:
    return bool(
        entry
        and entry.source in _VALID_SOURCES
        and entry.pair
        and isinstance(entry.candle_time, int)
        and entry.candle_time > 0
        and entry.direction in _VALID_DIRECTIONS
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def activate_ledger(disk_path: Optional[str] = None) -> None:
    """Turn on disk persistence and restore any previously-saved history.

    Idempotent — safe to call on every backtest run. Tests that want a pure
    in-memory ledger simply never call this.
    """
    with _lock:
        st = _get_state()
        if st.disk_path is not None:
            return
        st.disk_path = disk_path or _default_disk_path()
        st.retention_sec = _retention_sec()
        _load_disk(st)


def record_signal(
    *,
    source: str,
    pair: str,
    candle_time: int,
    direction: str,
    first_seen_sec: int,
    raw_candle_time: int = 0,
    outcome: Optional[int] = None,
    candle_outcome: Optional[int] = None,
    raw_status: Optional[str] = None,
) -> bool:
    """Record one signal. Returns True if it was stored or upgraded.

    Merge rules for an existing ``(source, pair, candle_time)``:

    - ``first_seen_sec`` keeps the EARLIEST non-zero value. The first time
      we see a signal is the closest thing we have to its true emission
      time; a later re-fetch must not push it forward and turn a genuine
      prediction into a look-ahead.
    - ``outcome`` / ``candle_outcome`` upgrade from ``None`` to a concrete
      verdict, and never downgrade back to ``None``.
    - ``direction`` is NOT overwritten. An app flipping its own call for a
      closed candle is a data-quality problem upstream; the ledger records
      what it first published.
    """
    entry = LedgerEntry(
        source=source,
        pair=pair,
        candle_time=int(candle_time or 0),
        direction=direction,
        first_seen_sec=int(first_seen_sec or 0),
        raw_candle_time=int(raw_candle_time or 0),
        outcome=outcome,
        candle_outcome=candle_outcome,
        raw_status=raw_status,
        recorded_at=time.time(),
    )
    if not _is_valid(entry):
        with _lock:
            _get_state().stats["skipped"] += 1
        return False

    key = (entry.source, entry.pair, entry.candle_time)
    with _lock:
        st = _get_state()
        existing = st.entries.get(key)
        if existing is None:
            st.entries[key] = entry
            st.stats["recorded"] += 1
            st.dirty = True
            return True

        changed = False
        if entry.first_seen_sec > 0 and (
            existing.first_seen_sec <= 0 or entry.first_seen_sec < existing.first_seen_sec
        ):
            existing.first_seen_sec = entry.first_seen_sec
            changed = True
        if existing.outcome is None and entry.outcome is not None:
            existing.outcome = entry.outcome
            changed = True
        if existing.candle_outcome is None and entry.candle_outcome is not None:
            existing.candle_outcome = entry.candle_outcome
            changed = True
        if not existing.raw_status and entry.raw_status:
            existing.raw_status = entry.raw_status
            changed = True
        if existing.raw_candle_time <= 0 < entry.raw_candle_time:
            existing.raw_candle_time = entry.raw_candle_time
            changed = True

        if changed:
            st.stats["updated"] += 1
            st.dirty = True
        return changed


def record_many(rows: Iterable[Dict[str, Any]]) -> int:
    """Bulk helper. Returns how many rows were stored or upgraded."""
    return sum(1 for row in rows if record_signal(**row))


def get_signals(
    *,
    min_candle_time: int = 0,
    sources: Optional[Iterable[str]] = None,
    pair: Optional[str] = None,
) -> List[LedgerEntry]:
    """Read back stored signals, newest candle first.

    ``min_candle_time`` is applied on the OFFSET-APPLIED candle time, which
    is what the backtest buckets on.
    """
    want = frozenset(sources) if sources else None
    with _lock:
        st = _get_state()
        out = [
            e for e in st.entries.values()
            if e.candle_time >= min_candle_time
            and (want is None or e.source in want)
            and (pair is None or e.pair == pair)
        ]
    out.sort(key=lambda e: (e.candle_time, e.source), reverse=True)
    return out


def flush(force: bool = True) -> None:
    """Persist pending changes. Called at the end of every backtest run."""
    with _lock:
        _save_disk(_get_state(), force=force)


def ledger_stats() -> Dict[str, Any]:
    """Diagnostics payload — surfaced by ``/api/diag``.

    ``perSource`` is the whole point: it makes the App 3 depth problem
    visible at a glance (before this module App 3's ``oldestAgeMin`` was
    pinned near 41, no matter how long the service had been up).
    """
    with _lock:
        st = _get_state()
        now = int(time.time())
        per_source: Dict[str, Dict[str, Any]] = {}
        for entry in st.entries.values():
            bucket = per_source.setdefault(
                entry.source, {"count": 0, "oldest": 0, "newest": 0}
            )
            bucket["count"] += 1
            if bucket["oldest"] == 0 or entry.candle_time < bucket["oldest"]:
                bucket["oldest"] = entry.candle_time
            if entry.candle_time > bucket["newest"]:
                bucket["newest"] = entry.candle_time
        for bucket in per_source.values():
            bucket["oldestAgeMin"] = (
                round((now - bucket["oldest"]) / 60, 1) if bucket["oldest"] else None
            )
            bucket["depthMin"] = (
                round((bucket["newest"] - bucket["oldest"]) / 60, 1)
                if bucket["oldest"] and bucket["newest"] else 0
            )
        return {
            "enabled": st.disk_path is not None,
            "diskPath": st.disk_path,
            "retentionHours": round(st.retention_sec / 3600, 1),
            "total": len(st.entries),
            "perSource": per_source,
            "loadedFromDisk": st.loaded_from_disk,
            "counters": dict(st.stats),
        }


def reset_ledger_for_tests() -> None:
    """Drop all state. Test-only."""
    global _state
    with _lock:
        _state = None
