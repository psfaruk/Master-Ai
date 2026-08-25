"""Tiny shared fetch helper used by the aggregator, the App 2 cache and the
backtest runner.

Returns parsed JSON with a hard timeout. Returns ``None`` on any failure mode
that isn't worth distinguishing (empty body, non-JSON body, non-2xx). Railway
occasionally answers with an HTML error page during a cold start; the original
TypeScript version retried once on a 5xx or a network error, which covers the
cold-start case — we do the same here.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
from typing import Any, Optional

import certifi
import httpx

logger = logging.getLogger("master-ai.http_fetcher")

DEFAULT_TIMEOUT_SEC = 10.0
DEFAULT_RETRIES = 1
USER_AGENT = "master-ai-python/1.0"
HEADERS = {"Accept": "application/json", "User-Agent": USER_AGENT}

# SSL context that uses certifi's CA bundle — works in slim Docker images
# that don't ship ca-certificates. Built once at module load.
_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())

# ---- Shared client ------------------------------------------------------
# Every call used to construct its own httpx.AsyncClient, which means a full
# TCP + TLS handshake per fetch. The snapshot poller runs at 0.8s during the
# burst window against 3 upstreams, the App 2 poller every 8s and the candle
# poller every 45s — several handshakes per second, sustained. That burns
# Railway CPU, adds ~100-200ms of latency to every poll, and leaks ephemeral
# ports under load.
#
# One process-wide client with a connection pool fixes all three. It is
# created lazily (so importing this module never touches the event loop) and
# closed by the lifespan shutdown hook via ``close_shared_client()``.
_shared_client: Optional[httpx.AsyncClient] = None
_client_lock = asyncio.Lock()

POOL_LIMITS = httpx.Limits(max_connections=20, max_keepalive_connections=10)


async def get_shared_client() -> httpx.AsyncClient:
    """Return the process-wide pooled client, creating it on first use."""
    global _shared_client
    if _shared_client is not None and not _shared_client.is_closed:
        return _shared_client
    async with _client_lock:
        if _shared_client is None or _shared_client.is_closed:
            _shared_client = httpx.AsyncClient(
                timeout=DEFAULT_TIMEOUT_SEC,
                headers=HEADERS,
                follow_redirects=True,
                verify=_SSL_CONTEXT,
                limits=POOL_LIMITS,
            )
    return _shared_client


async def close_shared_client() -> None:
    """Close the pooled client. Called from the FastAPI lifespan shutdown."""
    global _shared_client
    if _shared_client is not None and not _shared_client.is_closed:
        try:
            await _shared_client.aclose()
        except Exception:  # pragma: no cover — defensive
            logger.debug("shared client close failed", exc_info=True)
    _shared_client = None


async def fetch_json_with_timeout(
    url: str,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    *,
    retries: int = DEFAULT_RETRIES,
    client: Optional[httpx.AsyncClient] = None,
) -> Any:
    """Fetch JSON from ``url`` with a hard timeout and one retry.

    Returns ``None`` on any non-2xx response, non-JSON body, empty body, or
    final network failure. Raises only if every retry is exhausted AND the
    final failure was a transport error (the original TS behavior — callers
    rely on the exception to mark an app ``down``).
    """
    # Callers may inject their own client (tests do). Otherwise reuse the
    # pooled process-wide client instead of building a fresh one — see the
    # note on _shared_client above. We never close a client we don't own.
    owns_client = False
    if client is None:
        client = await get_shared_client()

    last_exc: Optional[Exception] = None
    try:
        for attempt in range(retries + 1):
            try:
                # timeout_sec is per-call, so pass it here rather than baking
                # it into the shared client (whose default is the 10s
                # DEFAULT_TIMEOUT_SEC).
                resp = await client.get(url, timeout=timeout_sec)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                last_exc = e
                if attempt < retries:
                    continue
                raise

            # 5xx is usually a cold start or a restart — worth one retry.
            if resp.status_code >= 500 and attempt < retries:
                last_exc = RuntimeError(f"HTTP {resp.status_code}")
                continue
            if resp.status_code >= 400:
                return None

            text = resp.text
            if not text:
                return None
            try:
                return resp.json()
            except Exception:
                # HTML error page or truncated body
                return None
    finally:
        if owns_client:
            await client.aclose()

    if last_exc:
        raise last_exc
    return None
