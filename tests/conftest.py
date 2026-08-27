"""Pytest configuration — make the ``app`` package importable from tests."""

import sys
import os
import tempfile

# Add the project root (one level up from tests/) to sys.path so tests can
# import the ``app.*`` modules.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# Isolate the App 2 disk cache: some tests boot the real FastAPI app (and
# therefore the real start_app2_cache_poller, which loads/saves the disk
# cache). Without this, a test run on a dev machine would load the dev
# instance's live history (data/app2_cache.json) and pollute assertions.
# Point the persistence at a fresh per-session temp file instead.
_APP2_CACHE_TMP = tempfile.mkdtemp(prefix="master-ai-test-cache-")
os.environ["APP2_CACHE_FILE"] = os.path.join(_APP2_CACHE_TMP, "app2_cache.json")

# Same isolation for the unified signal ledger. It is a process-global
# singleton that run_backtest() writes to on every call, so without a reset
# between tests one test's synthetic signals get replayed into the next
# test's backtest via the ledger backfill (observed: a 5-cluster fixture
# grading 10 clusters). Point persistence at a temp file AND wipe the
# in-memory state before every test.
_LEDGER_TMP = tempfile.mkdtemp(prefix="master-ai-test-ledger-")
os.environ["SIGNAL_LEDGER_FILE"] = os.path.join(_LEDGER_TMP, "signal_ledger.json")

# Same isolation for the runtime source-URL registry (Settings -> Signal
# Sources). A dev machine's saved data/source_config.json (pointing the
# upstreams at whatever the user's Railway apps are called TODAY) would
# otherwise leak into every test that builds routes keyed by the built-in
# default URLs. Point persistence at a per-session temp file instead.
_SOURCE_CFG_TMP = tempfile.mkdtemp(prefix="master-ai-test-sources-")
os.environ["SOURCE_CONFIG_FILE"] = os.path.join(_SOURCE_CFG_TMP, "source_config.json")

import pytest  # noqa: E402  (must come after the sys.path shim above)


def _wipe_ledger():
    """Reset in-memory ledger state AND remove its disk file.

    Both halves matter: run_backtest() calls activate_ledger() (which
    restores from disk) and flush() (which writes to it), so clearing only
    the in-memory dict would let the previous test's signals come straight
    back off disk on the next activate.
    """
    from app.signal_ledger import reset_ledger_for_tests

    reset_ledger_for_tests()
    try:
        os.unlink(os.environ["SIGNAL_LEDGER_FILE"])
    except OSError:
        pass


@pytest.fixture(autouse=True)
def _reset_signal_ledger():
    """Give every test a clean, empty signal ledger."""
    _wipe_ledger()
    yield
    _wipe_ledger()


@pytest.fixture(autouse=True)
def _reset_source_config():
    """Give every test the pristine default source URLs.

    Tests that POST new URLs through /api/sources must not leak their
    overrides into other tests (the config is a process-wide singleton
    backed by a disk file, exactly like the ledger).
    """
    from app.source_config import get_config

    get_config().reset_for_tests()
    yield
    get_config().reset_for_tests()
