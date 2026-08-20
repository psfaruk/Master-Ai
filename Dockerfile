# Minimal deterministic build for Railway / any container host.
#
# Design goals:
#   - NO apt-get (the Debian trixie package index is ~10MB and times out /
#     OOMs on Railway's smallest plan during build).
#   - NO build-essential (compiling httptools/uvloop OOMs the build).
#   - Everything must ship as a pre-built Linux x86_64 wheel.
#   - Keep memory usage LOW during pip install (pip can spike to 300+ MB
#     when resolving deps — Railway's smallest plan has 512 MB RAM for the
#     build container).
#
# python:3.12-slim already ships:
#   - Python 3.12 + pip + stdlib
#   - ca-certificates (but we use certifi explicitly to be safe)
#   - No curl, but we don't need it: Railway probes /health via its own
#     external HTTP probe (configured in railway.json), not via a Docker
#     HEALTHCHECK.

FROM python:3.12-slim

WORKDIR /app

# Disable pip's cache (smaller image + less memory pressure) and force
# wheels only. --no-build-isolation skips creating a separate build env
# per package, which saves ~50 MB peak memory.
ENV PIP_NO_CACHE_DIR=1 \
    PIP_NO_BUILD_ISOLATION=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ONLY_BINARY=:all:

# Install dependencies first so this layer is cached when only the code
# changes. We don't upgrade pip — the version that ships with the python
# image is fine, and upgrading it downloads ~10 MB which is wasted I/O on
# every build.
COPY requirements.txt .
RUN pip install -r requirements.txt

# Copy the application code.
COPY . .

# Railway injects PORT. Default to 8000 for local docker runs.
ENV PORT=8000 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

EXPOSE 8000

# No Docker HEALTHCHECK — Railway probes /health externally via the
# healthcheckPath set in railway.json. Adding one here would require
# installing curl, which requires apt-get, which fails on Railway's
# smallest plan.

# Run uvicorn via `exec` so uvicorn replaces sh as PID 1 and receives
# SIGTERM directly when Railway/docker stop sends it. Without `exec`, sh
# becomes PID 1 and uvicorn is its child — SIGTERM hits sh, which exits
# without propagating the signal to uvicorn, so uvicorn is force-KILLed
# after the grace period without running its lifespan shutdown hook
# (cancelling the app2_cache / candle_fetcher / snapshot_poller background
# tasks cleanly). In-flight HTTP requests are dropped. (REVIEW-2 C6.)
# Also: run as a non-root user (app) so an RCE in any dependency doesn't
# give the attacker root inside the container. (REVIEW-2 H8.)
RUN useradd -r -m -u 1000 app && chown -R app:app /app
USER app
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
