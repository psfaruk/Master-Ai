"""Background poller — runs inside the FastAPI server process.

ADAPTIVE polling:

- During the first ``BURST_WINDOW_SEC`` of each candle (i.e. when
  ``unix_seconds % 60 < BURST_WINDOW_SEC``), poll every
  ``BURST_INTERVAL_MS``.
- For the rest of the candle, poll every ``IDLE_INTERVAL_MS``.

This is the key fix for the "signals appear 27-32s late" complaint. The
source apps publish their next-candle signal within a few seconds of a new
candle opening; the old fixed 5s interval could land up to 5s late on top
of the source's own latency. The burst interval (800ms) means we capture
the source app's new signal within ~1s of it being emitted.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

from .app2_cache import start_app2_cache_poller
from .signal_aggregator import AggregatedResponse, aggregate_signals

logger = logging.getLogger("master-ai.snapshot_poller")

# Fast poll interval — used during the first BURST_WINDOW_SEC of a candle.
BURST_INTERVAL_SEC = 0.8
# Slow poll interval — used for the remainder of the candle. No new signal
# is expected during this window, so it's kept slow to cut idle request
# volume (and Railway compute cost) without affecting candle-open latency.
IDLE_INTERVAL_SEC = 6.0
# Window after candle open during which we poll fast.
BURST_WINDOW_SEC = 12


@dataclass
class SnapshotPollerState:
    cached_snapshot: Optional[AggregatedResponse] = None
    last_poll_at: float = 0.0
    poll_in_progress: bool = False
    poll_task: Optional[asyncio.Task] = None  # the loop task
    # Kick-off task — also tracked so the lifespan shutdown hook can
    # cancel it cleanly (previously fire-and-forget, leaked on shutdown).
    # (REVIEW-1 H7.)
    initial_task: Optional[asyncio.Task] = None
    started: bool = False


_state: Optional[SnapshotPollerState] = None


def _get_state() -> SnapshotPollerState:
    global _state
    if _state is None:
        _state = SnapshotPollerState()
    return _state


def _next_gap_sec() -> float:
    """Compute the gap until the next poll, based on how far into the current
    minute we are. We poll fast during the first BURST_WINDOW_SEC of a candle
    (when new signals are arriving) and slow for the rest of the minute."""
    now = time.time()
    sec_into_candle = int(now) % 60
    if sec_into_candle < BURST_WINDOW_SEC:
        return BURST_INTERVAL_SEC
    return IDLE_INTERVAL_SEC


async def _poll_once() -> None:
    st = _get_state()
    if st.poll_in_progress:
        return
    st.poll_in_progress = True
    try:
        snap = await aggregate_signals(1800)
        st.cached_snapshot = snap
        st.last_poll_at = time.time() * 1000
    except Exception as e:
        # Don't clear the cached snapshot on error — stale data is better
        # than no data. Just log and move on.
        logger.error("[poller] error: %s", e)
    finally:
        st.poll_in_progress = False


async def _poll_loop() -> None:
    """Self-rescheduling loop. We use ``asyncio.sleep`` (not a fixed
    interval) so we can vary the gap on every iteration — a fixed interval
    would either be too slow during the candle-open burst or too fast
    (wasteful) for the rest of the minute.

    ``asyncio.CancelledError`` is allowed to propagate so the lifespan
    shutdown hook can cleanly stop the loop.
    """
    while True:
        try:
            await _poll_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # pragma: no cover — defensive
            logger.error("[poller] loop iteration error: %s", e)
        await asyncio.sleep(_next_gap_sec())


def start_poller() -> None:
    """Start the background poller (idempotent — safe to call multiple
    times)."""
    st = _get_state()
    if st.started:
        return
    st.started = True
    # Start the App 2 historical-signal cache poller too (it runs in
    # parallel).
    start_app2_cache_poller()
    # Kick off the first poll immediately (async, don't block). Track it so
    # lifespan shutdown can cancel it cleanly (previously fire-and-forget —
    # REVIEW-1 H7).
    st.initial_task = asyncio.create_task(_poll_once())
    st.poll_task = asyncio.create_task(_poll_loop())
    logger.info(
        "[poller] started — adaptive (burst %.1fs for first %ds of each candle, then %.1fs)",
        BURST_INTERVAL_SEC, BURST_WINDOW_SEC, IDLE_INTERVAL_SEC,
    )


def get_snapshot() -> dict:
    """Get the latest cached snapshot (or None if first poll hasn't
    finished)."""
    st = _get_state()
    return {
        "snapshot": st.cached_snapshot,
        "age_ms": int(time.time() * 1000 - st.last_poll_at) if st.last_poll_at > 0 else -1,
    }


async def refresh_snapshot() -> None:
    """Force a fresh poll (used by /api/snapshot?refresh=1)."""
    await _poll_once()
