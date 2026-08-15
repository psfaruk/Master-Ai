# Minimal deterministic build for Railway / any container host.
#
# Design goals:
#   - NO apt-get (the Debian trixie package index is ~10MB and times out /
#     OOMs on Railway's smallest plan during build).
#   - NO build-essential (compiling httptools/uvloop OOMs the build).
#   - Everything must ship as a pre-built Linux x86_64 wheel.
#
# python:3.12-slim already ships:
#   - ca-certificates at /etc/ssl/certs/ca-certificates.crt
#     → httpx can verify TLS to upstream apps out of the box.
#   - No curl, but we don't need it: Railway probes /health via its own
#     external HTTP probe (configured in railway.json), not via a Docker
#     HEALTHCHECK. So no in-container HTTP client is required.

FROM python:3.12-slim

WORKDIR /app

# Install dependencies first so this layer is cached when only the code
# changes. --no-cache-dir keeps the layer small; --only-binary=:all:
# forces pip to use pre-built wheels and fail loudly instead of trying to
# compile (which would OOM on small plans).
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

# No Docker HEALTHCHECK — Railway probes /health externally via the
# healthcheckPath set in railway.json. Adding one here would require
# installing curl, which requires apt-get, which fails on Railway's
# smallest plan.

# Run uvicorn directly — no extra shell wrapper needed.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
