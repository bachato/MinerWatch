# syntax=docker/dockerfile:1.6
#
# Multi-stage Dockerfile for MinerWatch.
#
# Stage 0 (frontend-builder): runs `npm install && npm run build` for
# the React/TypeScript app in frontend-react/. Output: dist/ with the
# bundled JS/CSS + index.html the FastAPI app serves under /v2/.
#
# Stage 1 (builder): grabs the system build deps that *might* be
# needed for native wheels of `cryptography` / `pywebpush` on less
# common architectures (Pi 32-bit, musl, …). On amd64 / arm64 the
# manylinux wheels are picked automatically and the build chain
# isn't even invoked — but having it available means the image
# still builds cleanly on every reasonable host.
#
# Stage 2 (runtime): copies only the resolved virtualenv, the
# application code and the React build into a fresh slim image. No
# compiler, no Node, no apt state, no build artefacts left behind.

###############################################################################
# Stage 0 — frontend-builder (React/Vite via Node 20)
###############################################################################
FROM node:20-slim AS frontend-builder

WORKDIR /build

# Install JS deps first so this layer is cached as long as the
# package manifests don't change. `npm install` rather than `npm ci`
# because we don't ship the lockfile in git yet — once we do, swap
# this for `npm ci` for fully reproducible builds.
COPY frontend-react/package.json frontend-react/package-lock.json* ./
RUN npm install --no-audit --no-fund

# Now bring in the sources and produce dist/.
COPY frontend-react/ ./
RUN npm run build


###############################################################################
# Stage 1 — builder (Python virtualenv)
###############################################################################
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Build deps used as a fallback if pre-built wheels aren't available
# for the target arch. On linux/amd64 and linux/arm64 these stay
# unused (cryptography ships manylinux wheels).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        gcc \
        libffi-dev \
        libssl-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy only requirements first so this layer is cached as long as
# requirements.txt doesn't change — speeds up rebuilds enormously.
COPY requirements.txt .

# Resolve the dependency tree into a self-contained virtualenv that
# the runtime stage will copy as-is.
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip \
 && /opt/venv/bin/pip install -r requirements.txt


###############################################################################
# Stage 2 — runtime
###############################################################################
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Make the venv's binaries visible without sourcing activate.
    PATH="/opt/venv/bin:$PATH"

# Bring the resolved virtualenv from the builder stage. No compiler
# or apt cache lands in the final image.
COPY --from=builder /opt/venv /opt/venv

# Run as a non-root user. UID/GID 1000 matches the typical first
# Linux user, so a host-side bind mount of ./data won't have weird
# permission flips when you switch between bare-metal and Docker.
RUN groupadd --system --gid 1000 minerwatch \
 && useradd  --system --uid 1000 --gid minerwatch --home-dir /app minerwatch

WORKDIR /app

# Application code. The .dockerignore excludes data/, reports/,
# .venv/, .git/, __pycache__, .DS_Store, etc., so this is just the
# pieces the running app actually needs.
COPY --chown=minerwatch:minerwatch backend            ./backend
COPY --chown=minerwatch:minerwatch config.example.yaml ./config.example.yaml

# React build output from stage 0. backend/config.py points
# FRONTEND_DIR at /app/frontend-react/dist, so this is where the SPA
# (and /sw.js, /favicon.svg, /assets/*) is served from.
COPY --chown=minerwatch:minerwatch --from=frontend-builder /build/dist ./frontend-react/dist

# Persistent runtime data: SQLite DB, VAPID keys, push subscriptions
# and logs. Declaring the VOLUME means containers started without an
# explicit mount still get a place to put this (avoiding silent loss
# of data on every restart).
RUN mkdir -p /app/data \
 && chown minerwatch:minerwatch /app/data
VOLUME ["/app/data"]

USER minerwatch

EXPOSE 8000

# Healthcheck via Python stdlib — avoids apt-installing curl / wget
# just for this. Hits /api/health every 30s; if the call raises
# (4xx/5xx/timeout) urllib propagates and Python exits non-zero,
# which Docker reads as "unhealthy".
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/api/health', timeout=4)" \
        || exit 1

# No --reload here: that's a dev convenience for start.sh, not for
# a long-running container.
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
