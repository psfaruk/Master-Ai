"""Tests for app/source_config.py — the runtime upstream URL registry.

Covers the URL "recognition" contract the Signal Sources panel depends on:

- normalize_base_url: every shape a user might paste, and the garbage that
  must be rejected with a useful message.
- extract_base_url: pasting ANY of an app's endpoint URLs configures the
  whole app (base cut at the earliest known path).
- Precedence: saved override > env var > built-in default, and reset.
- Persistence: overrides survive a fresh SourceConfig round-trip through
  the JSON file, and a corrupt file is ignored rather than fatal.
- probe_endpoint / probe_app: latency/row counting, failure shaping, and
  candidate-URL probing without saving.
"""

from __future__ import annotations

import json
import os

import pytest

from app import source_config
from app.source_config import (
    DEFAULT_BASE_URLS,
    ENDPOINT_TEMPLATES,
    SourceConfig,
    extract_base_url,
    normalize_base_url,
)


# ---------------------------------------------------------------------------
# normalize_base_url
# ---------------------------------------------------------------------------


def test_normalize_accepts_bare_railway_host():
    assert normalize_base_url("my-app-production.up.railway.app") == (
        "https://my-app-production.up.railway.app"
    )


def test_normalize_strips_whitespace_and_trailing_slash():
    assert normalize_base_url("  https://x.up.railway.app/  ") == "https://x.up.railway.app"
    assert normalize_base_url("https://x.up.railway.app///") == "https://x.up.railway.app"


def test_normalize_keeps_explicit_port_and_prefix_path():
    assert normalize_base_url("http://localhost:9000") == "http://localhost:9000"
    assert normalize_base_url("https://host.example/prefix") == "https://host.example/prefix"


def test_normalize_lowercases_scheme_and_host():
    assert normalize_base_url("HTTPS://X.UP.RAILWAY.APP") == "https://x.up.railway.app"


def test_normalize_rejects_garbage():
    for bad in (
        "",
        "   ",
        None,
        "not a url with spaces",
        "ftp://x.example",
        "https://",
        "just_a_word",
    ):
        with pytest.raises(ValueError):
            normalize_base_url(bad)


# ---------------------------------------------------------------------------
# extract_base_url — "সঠিক ভাবে ইউআরএল চিনতে পারে"
# ---------------------------------------------------------------------------


def test_extract_from_plain_base():
    assert extract_base_url("https://x.up.railway.app") == "https://x.up.railway.app"


def test_extract_from_endpoint_urls():
    base = "https://x.up.railway.app"
    for pasted in (
        "https://x.up.railway.app/api/share-signals",
        "https://x.up.railway.app/api/history?limit=5000",
        "https://x.up.railway.app/api/signals?limit=500",
        "https://x.up.railway.app/api/live",
        "https://x.up.railway.app/api/token-status",
        "x.up.railway.app/api/history?limit=500",  # no scheme
    ):
        assert extract_base_url(pasted) == base, pasted


def test_extract_from_endpoint_of_the_real_app3_default():
    pasted = "https://otclivedata.up.railway.app/api/signals?limit=500"
    assert extract_base_url(pasted) == "https://otclivedata.up.railway.app"


def test_extract_cuts_at_earliest_known_path():
    # A base that itself lives under a path prefix must not be mangled by a
    # known path appearing LATER in the string.
    url = "https://host.example/api/signals?limit=500"
    assert extract_base_url(url) == "https://host.example"


def test_every_default_app_resolves_all_its_endpoints():
    for app_id, kinds in ENDPOINT_TEMPLATES.items():
        for kind in kinds:
            url = source_config.resolve_source_url(app_id, kind)
            assert url.startswith(DEFAULT_BASE_URLS[app_id]), (app_id, kind, url)
            assert url != DEFAULT_BASE_URLS[app_id]  # template adds a path


# ---------------------------------------------------------------------------
# Precedence + persistence (fresh objects against a temp file)
# ---------------------------------------------------------------------------


def _fresh_config(tmp_path, monkeypatch, saved: dict | None = None, env: dict | None = None):
    """A SourceConfig wired to a per-test temp file + clean env vars."""
    path = tmp_path / "source_config.json"
    if saved is not None:
        path.write_text(json.dumps(saved), encoding="utf-8")
    monkeypatch.setattr(source_config, "_disk_path", lambda: str(path))
    for var in source_config.ENV_VARS.values():
        monkeypatch.delenv(var, raising=False)
    for var, val in (env or {}).items():
        monkeypatch.setenv(var, val)
    return SourceConfig()


def test_precedence_override_beats_env_beats_default(tmp_path, monkeypatch):
    cfg = _fresh_config(
        tmp_path,
        monkeypatch,
        env={"APP2_BASE_URL": "https://env-app2.example"},
    )
    assert cfg.get_base_url("app2") == "https://env-app2.example"
    assert cfg.base_url_source("app2") == "env"
    assert cfg.get_base_url("app1") == DEFAULT_BASE_URLS["app1"]
    assert cfg.base_url_source("app1") == "default"

    cfg.set_apps({"app2": {"baseUrl": "https://custom-app2.example"}})
    assert cfg.get_base_url("app2") == "https://custom-app2.example"
    assert cfg.base_url_source("app2") == "custom"


def test_set_apps_persists_and_round_trips(tmp_path, monkeypatch):
    cfg = _fresh_config(tmp_path, monkeypatch)
    cfg.set_apps({
        "app1": {"baseUrl": "my-new-app-production.up.railway.app"},
        "app3": {"baseUrl": "https://other.up.railway.app/api/share-signals"},
    })
    assert os.path.exists(source_config._disk_path())

    # A brand-new instance (like a fresh process) restores the same URLs.
    cfg2 = SourceConfig()
    cfg2.load()
    assert cfg2.get_base_url("app1") == "https://my-new-app-production.up.railway.app"
    assert cfg2.get_base_url("app3") == "https://other.up.railway.app"
    assert cfg2.resolve_url("app1", "signals") == (
        "https://my-new-app-production.up.railway.app/api/history?limit=500"
    )


def test_corrupt_config_file_is_ignored(tmp_path, monkeypatch):
    path = tmp_path / "source_config.json"
    path.write_text("{ not json !!!", encoding="utf-8")
    monkeypatch.setattr(source_config, "_disk_path", lambda: str(path))
    cfg = SourceConfig()
    cfg.load()  # must not raise
    assert cfg.get_base_url("app1") == DEFAULT_BASE_URLS["app1"]


def test_reset_restores_env_then_default(tmp_path, monkeypatch):
    cfg = _fresh_config(tmp_path, monkeypatch, env={"APP1_BASE_URL": "https://env1.example"})
    cfg.set_apps({"app1": {"baseUrl": "https://custom1.example"}})
    cfg.reset(["app1"])
    assert cfg.get_base_url("app1") == "https://env1.example"

    monkeypatch.delenv("APP1_BASE_URL")
    cfg.reset(["app1"])
    assert cfg.get_base_url("app1") == DEFAULT_BASE_URLS["app1"]


def test_set_apps_is_atomic_on_bad_url(tmp_path, monkeypatch):
    cfg = _fresh_config(tmp_path, monkeypatch)
    with pytest.raises(ValueError):
        cfg.set_apps({
            "app1": {"baseUrl": "https://good.example"},
            "app2": {"baseUrl": "bad url with spaces"},
        })
    # app1 must NOT have been applied — validation happens before mutation.
    assert cfg.get_base_url("app1") == DEFAULT_BASE_URLS["app1"]


def test_endpoint_overrides_take_priority(tmp_path, monkeypatch):
    cfg = _fresh_config(tmp_path, monkeypatch)
    cfg.set_apps({
        "app2": {
            "baseUrl": "https://app2.example",
            "endpoints": {"signals": "https://app2.example/custom/signals"},
        },
    })
    assert cfg.resolve_url("app2", "signals") == "https://app2.example/custom/signals"
    assert cfg.resolve_url("app2", "health") == "https://app2.example/api/status"
    # reset() wipes BOTH the base and endpoint overrides — back to defaults.
    cfg.reset(["app2"])
    assert cfg.resolve_url("app2", "signals") == (
        DEFAULT_BASE_URLS["app2"] + ENDPOINT_TEMPLATES["app2"]["signals"]
    )


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_probe_endpoint_counts_rows_and_latency(monkeypatch):
    async def fake_fetch(url, timeout_sec=None, retries=1):
        return {"rows": [{"a": 1}, {"a": 2}]}

    r = await source_config.probe_endpoint("https://x.example/api/share-signals", fetch=fake_fetch)
    assert r["ok"] is True
    assert r["rows"] == 2
    assert r["error"] is None
    assert isinstance(r["latencyMs"], int)


@pytest.mark.asyncio
async def test_probe_endpoint_shapes_failures(monkeypatch):
    async def none_body(url, timeout_sec=None, retries=1):
        return None  # httpx-level failure: non-2xx / HTML / empty

    r = await source_config.probe_endpoint("https://x.example/api/x", fetch=none_body)
    assert r["ok"] is False
    assert "JSON" in r["error"]

    async def transport_error(url, timeout_sec=None, retries=1):
        raise RuntimeError("All connection attempts failed")

    r = await source_config.probe_endpoint("https://x.example/api/x", fetch=transport_error)
    assert r["ok"] is False
    assert "connection" in r["error"].lower()


@pytest.mark.asyncio
async def test_probe_app_candidate_url_does_not_touch_saved_config(monkeypatch):
    cfg = source_config.get_config()
    saved = cfg.get_base_url("app2")
    candidate = "https://candidate-app.example"

    seen = {}

    async def fake_fetch(url, timeout_sec=None, retries=1):
        seen[url] = True
        if "/api/status" in url:
            return {"connected": True}
        return {"rows": [1, 2, 3]}

    r = await source_config.probe_app("app2", base_url=candidate, fetch=fake_fetch)
    assert r["reachable"] is True
    assert r["probeTarget"] == "candidate"
    assert all(u.startswith(candidate) for u in seen), seen
    # Saved config untouched.
    assert cfg.get_base_url("app2") == saved


def test_to_dict_reports_source_and_endpoints(monkeypatch):
    cfg = source_config.get_config()
    d = cfg.to_dict()
    by_id = {a["id"]: a for a in d["apps"]}
    assert set(by_id) == {"app1", "app2", "app3"}
    a3 = by_id["app3"]
    assert a3["source"] == "default"
    assert set(a3["endpoints"]) == set(ENDPOINT_TEMPLATES["app3"])
    assert a3["endpoints"]["health"]["url"].endswith("/api/token-status")
