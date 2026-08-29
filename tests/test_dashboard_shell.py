"""Dashboard shell delivery tests.

The HTML shell is the deployment fingerprint: it carries the ?v=<hash>
asset URLs, so whether users see the deployed UI at all depends on how the
shell is cached. Two real defects motivated these tests:

- The shell used to be served without no-store headers, so browsers kept
  the previous deploy's HTML (and through it, the previous JS/CSS bundle)
  alive — a successful Railway rollout still looked like "deploy hoy ni".
- The asset URLs used to be unversioned, so even a fresh shell could load
  a stale heuristically-cached bundle.
"""

from __future__ import annotations

import re
from fastapi.testclient import TestClient

from main import ASSET_VERSION, app as fastapi_app

client = TestClient(fastapi_app)


def test_shell_is_never_cached():
    r = client.get("/")
    assert r.status_code == 200
    cache_control = r.headers.get("cache-control", "")
    assert "no-store" in cache_control, (
        "the HTML shell must send Cache-Control: no-store — otherwise "
        "browsers keep showing the previous deploy after a rollout"
    )


def test_shell_references_versioned_assets():
    r = client.get("/")
    assert r.status_code == 200
    html = r.text
    for asset in ("dashboard.js", "dashboard.css"):
        assert re.search(rf"/static/{asset}\?v=[0-9a-f]+", html), (
            f"{asset} must be referenced with a ?v= cache-busting hash"
        )


def test_shell_asset_hash_matches_startup_fingerprint():
    r = client.get("/")
    assert f"/static/dashboard.js?v={ASSET_VERSION}" in r.text
    assert f"/static/dashboard.css?v={ASSET_VERSION}" in r.text


def test_versioned_asset_url_actually_serves_the_bundle():
    url = f"/static/dashboard.js?v={ASSET_VERSION}"
    r = client.get(url)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript")
