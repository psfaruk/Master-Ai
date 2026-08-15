# Deterministic build for Railway / any container host.
# Uses python:3.12-slim so the Python version is pinned exactly, and we
# install deps into a virtualenv so the runtime image is minimal.

FROM python:3.12-slim AS builder

# Build deps that some Python packages need at install time.
#   build-essential — for C extensions (uvicorn's `standard` extras pull in
#     `httptools` / `uvloop` which compile against the system toolchain)
#   curl — used by Railway's healthcheck probes
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so this layer is cached when only the code
# changes. We use --no-cache-dir to keep the image small.
COPY requirements.txt .
RUN python -m pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# --- Runtime stage ---
FROM python:3.12-slim

# curl is needed for Railway's healthcheck probes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed packages from the builder stage.
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy the application code.
COPY . .

# Railway injects PORT. Default to 8000 for local docker runs.
ENV PORT=8000 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

EXPOSE 8000

# Healthcheck — Railway will use this to know when the container is ready.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8000}/health" || exit 1

# Run uvicorn directly — no extra shell wrapper needed.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
