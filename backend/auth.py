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
    expected = cfg.auth.password or ""
    if not expected:
        return
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
