"""Tiny shared fetch helper used by the aggregator, the App 2 cache and the
backtest runner.

Returns parsed JSON with a hard timeout. Returns ``None`` on any failure mode
that isn't worth distinguishing (empty body, non-JSON body, non-2xx). Railway
occasionally answers with an HTML error page during a cold start; the original
TypeScript version retried once on a 5xx or a network error, which covers the
cold-start case — we do the same here.
"""

from __future__ import annotations

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
    owns_client = client is None
    if owns_client:
        # verify=_SSL_CONTEXT uses certifi's CA bundle explicitly so we don't
        # depend on the host OS shipping ca-certificates.
        client = httpx.AsyncClient(
            timeout=timeout_sec,
            headers=HEADERS,
            follow_redirects=True,
            verify=_SSL_CONTEXT,
        )

    last_exc: Optional[Exception] = None
    try:
        for attempt in range(retries + 1):
            try:
                resp = await client.get(url)
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
