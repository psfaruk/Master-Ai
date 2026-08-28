"""Master-Ai — Python edition.

A FastAPI port of the original Next.js/TypeScript Quotex signal aggregator
dashboard.

Run::

    uvicorn main:app --reload --host 0.0.0.0 --port 8000

Or via the Railway start command::

    uvicorn main:app --host 0.0.0.0 --port $PORT
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.api.routes import NO_STORE_HEADERS, router as api_router
from app.snapshot_poller import start_poller

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s: %(message)s",
)
logger = logging.getLogger("master-ai")


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "app", "templates")
STATIC_DIR = os.path.join(BASE_DIR, "app", "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI startup/shutdown hook.

    Starts the adaptive snapshot poller on boot — that in turn starts the
    App 2 history cache poller and the candle cache poller. All three run
    as asyncio tasks inside the same process and live for the lifetime of
    the process.

    On shutdown, all background tasks are cancelled so uvicorn doesn't print
    "Task was destroyed but it is pending!" warnings.
    """
    logger.info("starting Master-Ai (Python edition)…")
    start_poller()
    yield
    logger.info("shutting down Master-Ai…")
    # Cancel background pollers cleanly so the event loop drains before exit.
    # Each poller exposes its asyncio task on its state object — under
    # ``task`` / ``initial_task`` for app2_cache / candle_fetcher, and under
    # ``poll_task`` / ``initial_task`` for the snapshot poller (which has
    # multiple background coroutines). The initial_task slots were added in
    # REVIEW-1 H7 to track the previously fire-and-forget kick-off polls.
    from app.app2_cache import _get_state as _app2_state
    from app.backtest_runner import _get_cache as _backtest_state
    from app.candle_fetcher import _get_state as _candle_state
    from app.snapshot_poller import _get_state as _snap_state

    pending = []
    # (state getter, primary task attr, initial task attr)
    for st_getter, task_attr, init_attr in (
        (_snap_state, "poll_task", "initial_task"),
        (_app2_state, "task", "initial_task"),
        (_candle_state, "task", "initial_task"),
        (_backtest_state, None, "refresh_task"),  # backtest cache uses refresh_task
    ):
        try:
            st = st_getter()
            for attr in (task_attr, init_attr):
                if attr is None:
                    continue
                task = getattr(st, attr, None)
                if task is not None and not task.done():
                    task.cancel()
                    pending.append(task)
        except Exception as e:
            # Don't let a single state object's failure cascade — keep
            # cancelling the others. (Defensive, REVIEW-1 M1.)
            logger.debug("shutdown: state cleanup error: %s", e)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    # Flush the App 2 history cache to disk so the last polled candles
    # survive the shutdown (the poller's debounced save can lag a few
    # seconds behind the last poll).
    try:
        from app.app2_cache import save_app2_cache_now
        save_app2_cache_now()
    except Exception:
        logger.debug("shutdown: app2 cache flush failed", exc_info=True)

    # Same for the unified signal ledger. Its disk write is debounced to at
    # most one every 20s, so without this flush the final ~20s of observed
    # signals are lost on every redeploy — exactly the window a Railway
    # deploy tends to interrupt.
    try:
        from app.signal_ledger import flush as flush_ledger
        flush_ledger(force=True)
    except Exception:
        logger.debug("shutdown: signal ledger flush failed", exc_info=True)

    # Close the pooled HTTP client so uvicorn doesn't warn about an
    # unclosed AsyncClient / leaked sockets on exit.
    try:
        from app.http_fetcher import close_shared_client
        await close_shared_client()
    except Exception:
        logger.debug("shutdown: http client close failed", exc_info=True)


app = FastAPI(
    title="Master-Ai",
    description="Quotex signal aggregator dashboard — Python edition",
    version="1.0.0",
    lifespan=lifespan,
)

# Mount the API router (all endpoints under /api/*).
app.include_router(api_router)

# Mount templates + static assets for the dashboard UI.
templates = Jinja2Templates(directory=TEMPLATES_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ---- Static asset cache-busting version ------------------------------
# Browsers are free to cache /static/dashboard.js|css heuristically (no
# Cache-Control header on StaticFiles), so after a redeploy users could
# keep running the OLD JS/CSS for a long time — the redesigned UI would
# never reach them. We fingerprint the two assets at startup (mtime+size)
# and stamp every reference as ?v=<hash>, so any deploy that changes the
# files forces every browser to fetch the fresh copies.
def _asset_version() -> str:
    h = hashlib.sha1()
    for fname in ("dashboard.css", "dashboard.js"):
        try:
            st = os.stat(os.path.join(STATIC_DIR, fname))
            h.update(fname.encode())
            h.update(str(st.st_mtime_ns).encode())
            h.update(str(st.st_size).encode())
        except OSError:
            h.update(fname.encode())
    return h.hexdigest()[:10]


ASSET_VERSION = _asset_version()


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """The main dashboard page — a server-rendered HTML shell that polls the
    JSON API for live data."""
    return templates.TemplateResponse(
        request=request,
        name="dashboard.html",
        context={"version": "1.0.0", "asset_version": ASSET_VERSION},
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Catches any uncaught exception, logs it with the full traceback, and
    returns a generic 500 to the client. We DO NOT echo ``str(exc)`` to the
    response body — the original behavior leaked library internals / file
    paths to anyone with a CORS-* response. (REVIEW-1 M2.)"""
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_error",
            "message": "Internal server error — see server logs for details.",
        },
        # Every /api/* route promises no-store; an unhandled 500 must not
        # be the one response a browser/proxy is allowed to cache.
        headers=NO_STORE_HEADERS,
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )
