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
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.api.routes import router as api_router
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
    # ``task`` for app2_cache / candle_fetcher, and under ``poll_task`` for
    # the snapshot poller (which has multiple background coroutines).
    from app.app2_cache import _get_state as _app2_state
    from app.candle_fetcher import _get_state as _candle_state
    from app.snapshot_poller import _get_state as _snap_state

    pending = []
    for st_getter, task_attr in (
        (_snap_state, "poll_task"),
        (_app2_state, "task"),
        (_candle_state, "task"),
    ):
        try:
            st = st_getter()
            task = getattr(st, task_attr, None)
            if task is not None and not task.done():
                task.cancel()
                pending.append(task)
        except Exception:
            pass
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


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


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """The main dashboard page — a server-rendered HTML shell that polls the
    JSON API for live data."""
    return templates.TemplateResponse(
        request=request,
        name="dashboard.html",
        context={"version": "1.0.0"},
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"error": "internal_error", "message": str(exc)},
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
