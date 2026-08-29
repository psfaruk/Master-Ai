"""Runtime-configurable upstream source URLs — the URL registry.

THE PROBLEM THIS SOLVES
-----------------------
The three upstream signal apps live on Railway. They get deleted and
redeployed every few days, and EVERY redeploy changes the subdomain
(``xyz-production.up.railway.app`` -> ``abc-production.up.railway.app``).
The URLs used to be hardcoded in FOUR modules (signal_aggregator,
backtest_runner, candle_fetcher, app2_cache), so a redeploy meant "the
dashboard silently stops receiving data until someone edits code and
redeploys THIS app too".

This module makes the upstream URLs RUNTIME-CONFIGURABLE:

- This registry owns every upstream URL the app fetches. Nothing else in
  the codebase hardcodes a host any more.
- The dashboard's Settings -> Signal Sources panel POSTs new URLs to
  ``/api/sources``; this module validates + normalizes + persists them to
  disk, and every fetch point resolves the current URL AT CALL TIME — so a
  redeployed Railway app reconnects within seconds. No code edit, no
  redeploy of the aggregator.
- Precedence: dashboard override (saved to disk)  >  ``APP1/2/3_BASE_URL``
  env var  >  built-in default (the URLs this repo shipped with).

URL ACCEPTANCE (সঠিক ভাবে ইউআরএল চিনতে পারে)
---------------------------------------------
Users paste URLs in every possible shape. All of the following are
accepted for App 1 and normalize to the same base URL:

    minimum-pair-production.up.railway.app
    https://minimum-pair-production.up.railway.app
    https://minimum-pair-production.up.railway.app/
    https://minimum-pair-production.up.railway.app/api/history?limit=500
    http://localhost:9000                      (self-hosted / tests)

Rules:

- Leading/trailing whitespace and trailing ``/`` are stripped.
- A missing scheme gets ``https://`` (Railway is always HTTPS).
- If the pasted URL contains one of the apps' KNOWN endpoint paths
  (``/api/history``, ``/api/share-signals``, ``/api/signals``,
  ``/api/live``, ``/api/status``, ``/api/token-status``), it is treated as
  a FULL endpoint URL and the base is cut at the earliest known path —
  so pasting any single endpoint URL configures the whole app.
- Everything else must be scheme + host (+ optional port/prefix path),
  otherwise ``ValueError`` with a human-readable message.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from .http_fetcher import fetch_json_with_timeout
from .signal_normalize import pick_array

logger = logging.getLogger("master-ai.source_config")

APP_IDS = ("app1", "app2", "app3")

# Built-in defaults — the original hardcoded hosts, kept as the fallback
# layer so an out-of-the-box deploy behaves exactly like before.
DEFAULT_BASE_URLS: Dict[str, str] = {
    "app1": "https://minimum-pair-production.up.railway.app",
    "app2": "https://binary-signals-app-production.up.railway.app",
    "app3": "https://otclivedata.up.railway.app",
}

# Env-var override layer (set on Railway before boot if desired).
ENV_VARS: Dict[str, str] = {
    "app1": "APP1_BASE_URL",
    "app2": "APP2_BASE_URL",
    "app3": "APP3_BASE_URL",
}

# Every URL the app fetches, per app, expressed as a path template off the
# base URL. ``kind`` names are stable identifiers used by the fetch points:
#
#   signals      - the hot-path live endpoint the aggregator polls
#   live         - App 1's /api/live (merged into history rows)
#   history      - App 3's resolved historical endpoint
#   history_full - App 1's history at limit=5000 (backtest only — the hot
#                  path uses limit=500; see backtest_runner.SOURCES)
#   health       - the health/status endpoint
#
ENDPOINT_TEMPLATES: Dict[str, Dict[str, str]] = {
    "app1": {
        "signals": "/api/history?limit=500",
        "live": "/api/live",
        "history_full": "/api/history?limit=5000",
        "health": "/api/status",
    },
    "app2": {
        "signals": "/api/share-signals",
        "health": "/api/status",
    },
    "app3": {
        "signals": "/api/share-signals",
        "history": "/api/signals?limit=500",
        "health": "/api/token-status",
    },
}

# JSON-array fields each endpoint's rows may arrive in — used by the probe
# to report "this endpoint answered with N rows".
_ENDPOINT_ROW_KEYS = ["signals", "rows", "history", "data", "items", "live"]

# Known endpoint paths — a pasted URL containing one of these is treated as
# a FULL endpoint URL, and the base is cut at the earliest match. Sorted by
# length DESC so "/api/token-status" is preferred over any shorter string
# that happens to be inside it.
KNOWN_ENDPOINT_PATHS = sorted(
    {p.split("?")[0] for tpl in ENDPOINT_TEMPLATES.values() for p in tpl.values()},
    key=len,
    reverse=True,
)

_APP_ID_RE = re.compile(r"^[a-z0-9_-]+$")
# Host sanity: something with a dot (railway.app, example.com), or an
# explicit local host so self-hosted instances / tests work.
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"}


# ---------------------------------------------------------------------------
# URL normalization / validation
# ---------------------------------------------------------------------------


def normalize_base_url(raw: str) -> str:
    """Validate + normalize a user-pasted base URL.

    Returns the canonical form: ``scheme://host[:port][/prefix]`` with no
    trailing slash. Raises ``ValueError`` with a human-readable message for
    anything that isn't a plausible http(s) URL.
    """
    if raw is None:
        raise ValueError("URL is empty")
    url = str(raw).strip()
    if not url:
        raise ValueError("URL is empty")
    if any(ch.isspace() for ch in url):
        raise ValueError("URL must not contain spaces")
    if url.startswith("//"):  # protocol-relative
        url = "https:" + url
    if "://" not in url:
        url = "https://" + url
    url = url.rstrip("/")
    if not url:
        raise ValueError("URL is empty")

    try:
        parts = urlsplit(url)
    except ValueError as e:
        raise ValueError(f"URL could not be parsed: {e}") from e

    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"URL scheme must be http or https (got '{parts.scheme or 'none'}')")
    netloc = parts.netloc
    if not netloc:
        raise ValueError("URL has no host — expected something like https://<app>.up.railway.app")
    if "@" in netloc:
        raise ValueError("URL must not contain username/password")

    host = parts.hostname or ""
    if not host:
        raise ValueError("URL has no host")
    if "." not in host and host.lower() not in _LOCAL_HOSTS and "%" not in host:
        raise ValueError(
            f"'{host}' does not look like a real host — expected e.g. <name>.up.railway.app"
        )

    # Canonicalize: lowercase scheme/host, keep port + explicit prefix path.
    # (urlsplit already splits port for us; netloc casing matters for
    # comparison only, so rebuild it lowercased.)
    netloc = netloc.lower()
    path = parts.path
    rebuilt = f"{scheme}://{netloc}{path}"
    if parts.query:
        rebuilt += f"?{parts.query}"
    return rebuilt.rstrip("/")


def extract_base_url(raw: str) -> str:
    """Accept ANY shape of pasted URL and return the app's base URL.

    If the input contains a known endpoint path (e.g. the user pasted
    ``https://x.up.railway.app/api/share-signals``), everything from that
    path on (including any query string) is cut off — the remaining prefix
    is the base URL all of the app's endpoints hang off.
    """
    url = normalize_base_url(raw)
    cut_at: Optional[int] = None
    for path in KNOWN_ENDPOINT_PATHS:
        idx = url.find(path)
        if idx != -1 and (cut_at is None or idx < cut_at):
            cut_at = idx
    if cut_at is not None and cut_at > 0:
        url = url[:cut_at]
    return url.rstrip("/")


# ---------------------------------------------------------------------------
# Config store
# ---------------------------------------------------------------------------


def _disk_path() -> str:
    """JSON file the runtime overrides are persisted to.

    Overridable via ``SOURCE_CONFIG_FILE`` (Railway env). Defaults to
    ``<repo>/data/source_config.json`` — the Dockerfile runs as the ``app``
    user with a writable /app, so this works on Railway without a volume.
    (Without a volume the file resets on redeploy — but the redeploy the
    user does is of the UPSTREAM apps, not this one, so the saved URLs
    survive exactly as long as this app does.)
    """
    env = os.environ.get("SOURCE_CONFIG_FILE", "").strip()
    if env:
        return env
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "data", "source_config.json")


class SourceConfig:
    """Holds the runtime URL overrides for the three source apps.

    All reads happen through :func:`resolve_url` at fetch time, so saving a
    new URL takes effect on the very next poll — no restart, no cache
    invalidation of the fetch clients.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # app_id -> user-set base URL or None (fall through to env/default)
        self._overrides: Dict[str, Optional[str]] = {a: None for a in APP_IDS}
        # app_id -> {kind -> FULL endpoint URL} — advanced per-endpoint overrides
        self._endpoint_overrides: Dict[str, Dict[str, str]] = {a: {} for a in APP_IDS}
        self.updated_at_ms: int = 0
        self._loaded = False

    # ---- resolution -----------------------------------------------------

    def _env_url(self, app_id: str) -> Optional[str]:
        raw = os.environ.get(ENV_VARS[app_id], "").strip()
        return raw or None

    def base_url_source(self, app_id: str) -> str:
        """Where the effective URL comes from: "custom" | "env" | "default"."""
        with self._lock:
            if self._overrides.get(app_id):
                return "custom"
        if self._env_url(app_id):
            return "env"
        return "default"

    def get_base_url(self, app_id: str) -> str:
        """The effective base URL for an app (override > env > default)."""
        if app_id not in APP_IDS:
            raise KeyError(f"unknown app id: {app_id}")
        with self._lock:
            override = self._overrides.get(app_id)
        if override:
            return override
        env = self._env_url(app_id)
        if env:
            return env
        return DEFAULT_BASE_URLS[app_id]

    def resolve_url(self, app_id: str, kind: str) -> str:
        """Build the full URL for ``app_id``'s endpoint ``kind`` right now.

        Per-endpoint overrides win, then base URL + template. Called on
        EVERY fetch, so a saved URL change applies on the next poll.
        """
        if app_id not in APP_IDS:
            raise KeyError(f"unknown app id: {app_id}")
        with self._lock:
            override = self._endpoint_overrides.get(app_id, {}).get(kind)
        if override:
            return override
        template = ENDPOINT_TEMPLATES[app_id].get(kind)
        if template is None:
            raise KeyError(f"unknown endpoint kind '{kind}' for {app_id}")
        return f"{self.get_base_url(app_id)}{template}"

    # ---- mutation -------------------------------------------------------

    def _validate_all(self, apps: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        """Validate the whole POST payload BEFORE mutating anything.

        Returns a normalized structure; raises ValueError on the first bad
        URL with a message naming the app.
        """
        normalized: Dict[str, Dict[str, Any]] = {}
        for app_id, spec in apps.items():
            if app_id not in APP_IDS:
                raise ValueError(f"unknown app id '{app_id}' — expected one of {', '.join(APP_IDS)}")
            if not isinstance(spec, dict):
                raise ValueError(f"{app_id}: payload must be an object")
            out: Dict[str, Any] = {}
            if "baseUrl" in spec and spec["baseUrl"] is not None:
                raw = str(spec["baseUrl"]).strip()
                if raw == "":
                    raise ValueError(f"{app_id}: URL is empty — to revert to the default use /api/sources/reset")
                out["base_url"] = extract_base_url(raw)
            endpoints = spec.get("endpoints")
            if endpoints:
                if not isinstance(endpoints, dict):
                    raise ValueError(f"{app_id}: endpoints must be an object")
                kinds = ENDPOINT_TEMPLATES[app_id]
                parsed: Dict[str, str] = {}
                for kind, val in endpoints.items():
                    if kind not in kinds:
                        raise ValueError(f"{app_id}: unknown endpoint '{kind}' — expected one of {', '.join(kinds)}")
                    u = str(val or "").strip()
                    if not u:
                        continue
                    try:
                        parsed[kind] = normalize_base_url(u)
                    except ValueError as e:
                        raise ValueError(f"{app_id}.{kind}: {e}") from e
                out["endpoints"] = parsed
            normalized[app_id] = out
        return normalized

    def set_apps(self, apps: Dict[str, Any]) -> None:
        """Apply a validated (or raw — validated here) payload and persist.

        Atomic: every URL is validated BEFORE any is applied, so a typo in
        App 3's URL can't leave App 1 updated and App 3 broken.
        """
        normalized = self._validate_all(apps)
        with self._lock:
            for app_id, out in normalized.items():
                if "base_url" in out:
                    self._overrides[app_id] = out["base_url"]
                    # A base-URL repoint (the standard "app redeployed under a
                    # new subdomain" flow — see the /api/sources docstring
                    # example, which only ever sends baseUrl) must supersede
                    # any previously saved per-endpoint override. Without
                    # this, resolve_url() keeps returning the OLD, now-dead
                    # endpoint URL for whichever kind had an override, even
                    # though the base looks fully reconnected — silently
                    # starving that endpoint's fetches after every redeploy
                    # that follows an earlier advanced per-endpoint save.
                    # Endpoint overrides included in THIS SAME payload are
                    # (re)applied right below, so they still take effect.
                    self._endpoint_overrides[app_id] = {}
                for kind, url in out.get("endpoints", {}).items():
                    self._endpoint_overrides.setdefault(app_id, {})[kind] = url
            self.updated_at_ms = int(time.time() * 1000)
            self.save()

    def reset(self, app_ids: Optional[List[str]] = None) -> None:
        """Clear overrides for the given apps (default: all three).

        The effective URL falls back to env var, then the built-in default.
        """
        targets = [a for a in (app_ids or list(APP_IDS)) if a in APP_IDS]
        with self._lock:
            for app_id in targets:
                self._overrides[app_id] = None
                self._endpoint_overrides[app_id] = {}
            self.updated_at_ms = int(time.time() * 1000)
            self.save()

    # ---- persistence ----------------------------------------------------

    def save(self) -> None:
        """Atomically write the current overrides to disk (tmp + rename)."""
        path = _disk_path()
        with self._lock:
            payload = {
                "version": 1,
                "updated_at_ms": self.updated_at_ms,
                "apps": {
                    a: {
                        # Only persist non-null overrides; absent = fall through.
                        **({"base_url": self._overrides[a]} if self._overrides.get(a) else {}),
                        **({"endpoints": dict(self._endpoint_overrides[a])} if self._endpoint_overrides.get(a) else {}),
                    }
                    for a in APP_IDS
                },
            }
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = f"{path}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=1)
            os.replace(tmp, path)
        except OSError as e:
            # Not fatal — the runtime config still applies for this process.
            logger.warning("[sources] config save failed: %s", e)

    def load(self) -> None:
        """Restore previously-saved overrides from disk (once, lazily).

        A corrupt/half-written file must never take the app down — it is
        logged and ignored, exactly like the other disk caches.
        """
        with self._lock:
            if self._loaded:
                return
            self._loaded = True
        path = _disk_path()
        if not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError) as e:
            logger.warning("[sources] config load failed (using defaults): %s", e)
            return
        if not isinstance(raw, dict):
            return
        apps = raw.get("apps")
        if not isinstance(apps, dict):
            return
        loaded = 0
        for app_id, spec in apps.items():
            if app_id not in APP_IDS or not isinstance(spec, dict):
                continue
            base = spec.get("base_url")
            if isinstance(base, str) and base.strip():
                try:
                    self._overrides[app_id] = normalize_base_url(base)
                    loaded += 1
                except ValueError:
                    logger.warning("[sources] saved URL for %s is invalid — ignoring", app_id)
            endpoints = spec.get("endpoints")
            if isinstance(endpoints, dict):
                for kind, val in endpoints.items():
                    if isinstance(val, str) and val.strip() and kind in ENDPOINT_TEMPLATES[app_id]:
                        try:
                            self._endpoint_overrides.setdefault(app_id, {})[kind] = normalize_base_url(val)
                            loaded += 1
                        except ValueError:
                            logger.warning("[sources] saved endpoint %s.%s is invalid — ignoring", app_id, kind)
        if loaded:
            self.updated_at_ms = int(raw.get("updated_at_ms") or 0)
            logger.info("[sources] restored %d saved URL override(s) from %s", loaded, path)

    # ---- serialization --------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        """API shape for GET /api/sources (also the UI's render model)."""
        from .signal_aggregator import SOURCES  # local import: avoid a cycle

        meta = {s["id"]: s for s in SOURCES}
        apps_out = []
        with self._lock:
            for app_id in APP_IDS:
                m = meta.get(app_id, {})
                base = self.get_base_url(app_id)
                apps_out.append({
                    "id": app_id,
                    "name": m.get("name", app_id),
                    "shortName": m.get("short_name", app_id),
                    "baseUrl": base,
                    "source": self.base_url_source(app_id),
                    "defaultUrl": DEFAULT_BASE_URLS[app_id],
                    "envUrl": self._env_url(app_id),
                    "isCustom": self.base_url_source(app_id) == "custom",
                    "endpoints": {
                        kind: {
                            "kind": kind,
                            "url": self.resolve_url(app_id, kind),
                            "overridden": kind in self._endpoint_overrides.get(app_id, {}),
                        }
                        for kind in ENDPOINT_TEMPLATES[app_id]
                    },
                })
        return {
            "apps": apps_out,
            "updatedAtMs": self.updated_at_ms,
            "configFile": _disk_path(),
        }

    def reset_for_tests(self) -> None:
        """Test-only — wipe in-memory overrides WITHOUT saving to disk."""
        with self._lock:
            self._overrides = {a: None for a in APP_IDS}
            self._endpoint_overrides = {a: {} for a in APP_IDS}
            self.updated_at_ms = 0


_config: Optional[SourceConfig] = None
_config_lock = threading.Lock()


def get_config() -> SourceConfig:
    """Process-wide singleton; lazily loads saved overrides from disk."""
    global _config
    if _config is None:
        with _config_lock:
            if _config is None:
                cfg = SourceConfig()
                cfg.load()
                _config = cfg
    return _config


# ---- convenience accessors (the API every fetch point uses) ---------------


def resolve_source_url(app_id: str, kind: str) -> str:
    return get_config().resolve_url(app_id, kind)


def get_base_url(app_id: str) -> str:
    return get_config().get_base_url(app_id)


# ---------------------------------------------------------------------------
# Probing ("Test" button / post-save health check)
# ---------------------------------------------------------------------------


def _row_count(data: Any) -> int:
    """Best-effort row count for a fetched JSON body."""
    if data is None:
        return 0
    arr = pick_array(data, _ENDPOINT_ROW_KEYS)
    if arr:
        return len(arr)
    return 1 if data else 0  # a dict health payload counts as "1 row"


async def probe_endpoint(
    url: str,
    *,
    timeout_sec: float = 6.0,
    fetch=None,
) -> Dict[str, Any]:
    """Fetch one endpoint and describe the result for the UI.

    ``ok`` means HTTP 2xx + parseable JSON. Transport errors / timeouts /
    non-JSON (Railway cold-start HTML) all land in ``error``.
    """
    fetch_fn = fetch or fetch_json_with_timeout
    started = time.monotonic()
    try:
        data = await fetch_fn(url, timeout_sec, retries=0)
    except Exception as e:
        ms = int((time.monotonic() - started) * 1000)
        return {"url": url, "ok": False, "rows": 0, "latencyMs": ms, "error": _short_err(e)}
    ms = int((time.monotonic() - started) * 1000)
    if data is None:
        return {
            "url": url, "ok": False, "rows": 0, "latencyMs": ms,
            "error": "no JSON (non-2xx, empty body, or HTML error page)",
        }
    return {"url": url, "ok": True, "rows": _row_count(data), "latencyMs": ms, "error": None}


def _short_err(e: Exception) -> str:
    msg = str(e) or type(e).__name__
    msg = re.sub(r"\s+", " ", msg).strip()
    return msg[:160]


async def probe_app(
    app_id: str,
    *,
    base_url: Optional[str] = None,
    timeout_sec: float = 6.0,
    fetch=None,
) -> Dict[str, Any]:
    """Probe EVERY endpoint of one app in parallel.

    Used by the Settings "Test" button. When ``base_url`` is given, the
    CANDIDATE URL is probed without saving it first — so the user can
    check a redeployed app before committing the change.
    """
    cfg = get_config()
    if app_id not in APP_IDS:
        raise KeyError(f"unknown app id: {app_id}")
    base = (base_url or "").strip()
    if base:
        base = extract_base_url(base)

    import asyncio

    kinds = list(ENDPOINT_TEMPLATES[app_id].keys())
    urls = [
        f"{base}{ENDPOINT_TEMPLATES[app_id][k]}" if base else cfg.resolve_url(app_id, k)
        for k in kinds
    ]
    results = await asyncio.gather(
        *[probe_endpoint(u, timeout_sec=timeout_sec, fetch=fetch) for u in urls]
    )
    by_kind = {k: r for k, r in zip(kinds, results)}
    any_ok = any(r["ok"] for r in results)
    return {
        "app": app_id,
        "baseUrl": base or cfg.get_base_url(app_id),
        "probeTarget": "candidate" if base else "saved",
        "endpoints": by_kind,
        "reachable": any_ok,
    }


def config_status() -> Dict[str, Any]:
    """Compact source-config block for /api/diag."""
    cfg = get_config()
    return {
        "apps": {
            a: {
                "baseUrl": cfg.get_base_url(a),
                "source": cfg.base_url_source(a),
            }
            for a in APP_IDS
        },
        "updatedAtMs": cfg.updated_at_ms,
    }
