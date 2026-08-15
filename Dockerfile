# Deterministic build for Railway / any container host.
#
# Uses python:3.12-slim so the Python version is pinned exactly.
# Designed to NOT need build-essential — we install only pre-built wheels,
# which means the build fits in Railway's smallest plan (512MB RAM).
#
# If a future dep ever needs to compile C extensions, add a builder stage
# with `build-essential` there — but keep the runtime stage slim.

FROM python:3.12-slim

# curl is needed for Railway's HEALTHCHECK probe.
# We do NOT install build-essential: pure-Python wheels + uvicorn's bundled
# wheels (httptools, uvloop) cover everything we need.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so this layer is cached when only the code
# changes. --no-cache-dir keeps the layer small; --only-binary=:all: forces
# pip to use pre-built wheels and fail loudly instead of trying to compile
# (which would OOM on small plans).
COPY requirements.txt .
RUN python -m pip install --upgrade pip \
    && pip install --no-cache-dir --only-binary=:all: -r requirements.txt

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
