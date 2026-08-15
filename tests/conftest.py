"""Pytest configuration — make the ``app`` package importable from tests."""

import sys
import os

# Add the project root (one level up from tests/) to sys.path so tests can
# import the ``app.*`` modules.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
