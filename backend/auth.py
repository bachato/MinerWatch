# SPDX-License-Identifier: AGPL-3.0-only
"""Optional auth: bearer token. Disabled by default.

When enabled, every request must carry ``Authorization: Bearer <password>``
or the ``mw_token=<password>`` cookie (handy for the frontend).
"""
from __future__ import annotations

from fastapi import HTTPException, Request

from .config import get_config


def get_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    cookie_token = request.cookies.get("mw_token")
    return cookie_token or None


def require_auth(request: Request) -> None:
    cfg = get_config()
    if not cfg.auth.enabled:
        return
    expected = (cfg.auth.password or "").strip()
    if not expected:
        # Fail-closed: auth.enabled=True but no password configured.
        # Returning 200 here (the previous behaviour) silently bypassed
        # authentication, which is the opposite of what the operator
        # asked for. We now refuse every protected request.
        #
        # Recovery if you locked yourself out:
        #   1) edit config.yaml and set `auth.enabled: false`, OR
        #   2) `sqlite3 data/minerwatch.db
        #       "UPDATE settings SET value='false' WHERE key='auth.enabled';"`
        # then restart the app.
        raise HTTPException(
            status_code=401,
            detail="Authentication is enabled but no password is configured",
        )
    provided = get_token(request) or ""
    if provided != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def public_paths(path: str) -> bool:
    """Paths that stay public even when auth is enabled (e.g. login, sw.js)."""
    public = (
        "/login",
        "/api/auth/login",
        "/api/auth/status",
        "/sw.js",
        "/static/",
        "/favicon.ico",
    )
    return any(path == p or path.startswith(p) for p in public)
