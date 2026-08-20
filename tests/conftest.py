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
