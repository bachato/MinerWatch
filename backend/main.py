# SPDX-License-Identifier: AGPL-3.0-only
"""MinerWatch FastAPI entrypoint.

Run:
    uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

The ``start.sh`` script in the repo root does exactly this after
setting up the virtualenv.
"""
from __future__ import annotations

import asyncio
import hmac
import logging
from dataclasses import asdict
from typing import Any, Dict, Optional

from urllib.parse import quote

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db
from . import system_info
from .alerts import ensure_vapid_keys, public_key_b64
from .auth import (
    clear_login_failures,
    login_lockout_remaining,
    public_paths,
    record_login_failure,
    require_auth,
)
from .auto_control import auto_fan
from .config import FRONTEND_DIR, db_path, get_config, reload_config
from .discovery import discover_and_register, scan_network
from .miners import DRIVERS, driver_for_record
from .poller import poller

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("minerwatch")

app = FastAPI(title="MinerWatch", version="0.1.0")

# CORS restricted to the exact origin(s) actually used to open the
# dashboard. Listing each origin explicitly (rather than reflecting back
# whatever Origin header the request carries) means a malicious page in
# another tab cannot trick the browser into letting its own JavaScript
# read MinerWatch's responses, even if the user is logged in.
#
# If you start opening MinerWatch from a different origin (new hostname,
# different port, https instead of http, raw LAN IP, SSH tunnel on
# 127.0.0.1, …), add that origin to the list. Symptom of a missing entry:
# the page loads but API calls fail in the browser console with messages
# like "blocked by CORS policy".
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://denver.local:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Lifecycle ----------

@app.on_event("startup")
async def on_startup() -> None:
    cfg = get_config()
    await db.init_db()

    # Apply any overrides from the settings DB
    overrides = await db.all_settings()
    cfg.apply_overrides(
        {k: v for k, v in overrides.items() if not k.startswith("_")}
    )

    # One-shot tiered-retention migration. Backfills metrics_1m and
    # metrics_1h from existing raw data, trims raw to the configured
    # retention, and VACUUMs to actually shrink the file. The function
    # short-circuits if it has already run.
    if not await db.is_tier_migration_done():
        log.info("Running tiered-retention migration (one-shot)…")
        result = await db.run_tier_migration(
            retention_raw_hours=cfg.storage.retention_raw_hours,
            vacuum=True,
        )
        log.info(
            "Tier migration done: rolled_1m=%s rolled_1h=%s raw_deleted=%s vacuumed=%s",
            result.get("rolled_1m"),
            result.get("rolled_1h"),
            result.get("raw_deleted"),
            result.get("vacuumed"),
        )

    ensure_vapid_keys()

    # Fail-closed sanity check: if auth.enabled is True but the password
    # is empty, every protected request will 401. We don't crash the
    # process (that would create a boot loop and lock the user out
    # without a fix path), but we surface a loud warning in the log so
    # the misconfiguration isn't silent.
    if cfg.auth.enabled and not (cfg.auth.password or "").strip():
        log.warning(
            "auth.enabled=True but auth.password is empty — all protected "
            "requests will be rejected with 401. Either set a password in "
            "/settings, or disable auth in config.yaml / via the DB."
        )

    log.info("Starting MinerWatch — port %s", cfg.server.port)
    await poller.start()
    await auto_fan.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await auto_fan.stop()
    await poller.stop()


# ---------- Auth middleware ----------

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    cfg = get_config()
    path = request.url.path
    if cfg.auth.enabled and not public_paths(path):
        try:
            require_auth(request)
        except HTTPException as exc:
            # For API requests return 401 JSON; for HTML pages do a *real*
            # 302 redirect to /login with the original target as `next=`.
            # Serving login.html inline at the protected URL caused two
            # nasty issues: (1) browsers cached the login form under the
            # protected URL, creating a "click Settings → see login" loop,
            # and (2) the URL bar lied about what the user was looking at.
            if path.startswith("/api/"):
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
            target = path
            if request.url.query:
                target = f"{path}?{request.url.query}"
            return RedirectResponse(
                url=f"/login?next={quote(target, safe='')}",
                status_code=302,
            )
    response = await call_next(request)
    # When auth is enabled, the HTML page responses should never be cached
    # by intermediaries or the browser: a cached login or settings page
    # could leak to other users / sessions, and on iOS Safari the HTTP
    # cache is aggressive enough to serve stale content even after the
    # cookie has been set. Static assets keep their own cache policy.
    is_html_page = (
        path in {"/", "/settings", "/system", "/login"} or path.startswith("/miner/")
    )
    if cfg.auth.enabled and is_html_page:
        response.headers.setdefault("Cache-Control", "no-store")
    return response


# ---------- Pages ----------

@app.get("/", include_in_schema=False)
async def index() -> Response:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/miner/{miner_id}", include_in_schema=False)
async def miner_page(miner_id: int) -> Response:  # noqa: ARG001
    return FileResponse(FRONTEND_DIR / "miner.html")


@app.get("/settings", include_in_schema=False)
async def settings_page() -> Response:
    return FileResponse(FRONTEND_DIR / "settings.html")


@app.get("/system", include_in_schema=False)
async def system_page() -> Response:
    """Host-system stats page (Raspberry Pi-focused).

    Served on every host; the page itself bails out and shows an
    "only available on Raspberry Pi" message if /api/system/info reports
    is_raspberry=False — keeps the URL stable for dev/testing on macOS.
    """
    return FileResponse(FRONTEND_DIR / "system.html")


@app.get("/login", include_in_schema=False)
async def login_page() -> Response:
    return FileResponse(FRONTEND_DIR / "login.html")


@app.get("/sw.js", include_in_schema=False)
async def service_worker() -> Response:
    return FileResponse(FRONTEND_DIR / "sw.js", media_type="application/javascript")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    fav = FRONTEND_DIR / "static" / "favicon.svg"
    if fav.exists():
        return FileResponse(fav, media_type="image/svg+xml")
    return Response(status_code=204)


# Static
# This directory may not exist on first run: create it now.
(FRONTEND_DIR / "static").mkdir(parents=True, exist_ok=True)


class _NoCacheStaticFiles(StaticFiles):
    """StaticFiles with a ``Cache-Control: no-cache`` header on every response.

    Without it, browsers cache LAN CSS/JS aggressively and frontend updates
    (e.g. a new chart) require a manual hard-reload to show up. With
    ``no-cache`` the browser always revalidates with the server
    (ETag/Last-Modified), so we don't need to bump asset versions.
    """

    def is_not_modified(self, response_headers, request_headers) -> bool:  # type: ignore[override]
        return super().is_not_modified(response_headers, request_headers)

    def file_response(self, *args, **kwargs):  # type: ignore[override]
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp


app.mount(
    "/static",
    _NoCacheStaticFiles(directory=str(FRONTEND_DIR / "static")),
    name="static",
)


# ---------- API: miners ----------

class MinerCreate(BaseModel):
    family: str = Field(..., description="bitaxe | canaan | braiins")
    host: str
    port: Optional[int] = None
    name: Optional[str] = None
    notes: Optional[str] = None
    fan_threshold_c: Optional[float] = None


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "version": app.version}


@app.get("/api/miners")
async def api_list_miners() -> dict:
    miners = await db.list_miners()
    out = []
    for m in miners:
        latest = await db.latest_metric(m["id"])
        sample = poller.last_results.get(m["id"])
        out.append(
            {
                **m,
                "last_metric": latest,
                "live_online": bool(sample.online) if sample else None,
                "live_error": sample.error if sample else None,
            }
        )
    return {"miners": out}


@app.post("/api/miners")
async def api_create_miner(payload: MinerCreate) -> dict:
    if payload.family not in DRIVERS:
        raise HTTPException(400, f"invalid family (use: {', '.join(DRIVERS)})")
    miner_id = await db.upsert_miner(payload.model_dump(exclude_none=True))
    return {"id": miner_id}


@app.get("/api/miners/{miner_id}")
async def api_get_miner(miner_id: int) -> dict:
    miner = await db.get_miner(miner_id)
    if not miner:
        raise HTTPException(404, "miner not found")
    latest = await db.latest_metric(miner_id)
    sample = poller.last_results.get(miner_id)
    return {
        "miner": miner,
        "last_metric": latest,
        "live_sample": asdict(sample) if sample else None,
        "capabilities": _capabilities(miner["family"]),
    }


@app.delete("/api/miners/{miner_id}")
async def api_delete_miner(miner_id: int) -> dict:
    await db.delete_miner(miner_id)
    return {"deleted": miner_id}


@app.get("/api/miners/{miner_id}/metrics")
async def api_miner_metrics(
    miner_id: int,
    from_ts: int = 0,
    to_ts: int = 0,
) -> dict:
    import time as _time

    if to_ts == 0:
        to_ts = int(_time.time())
    if from_ts == 0:
        from_ts = to_ts - 24 * 3600
    rows, tier = await db.metrics_range(miner_id, from_ts, to_ts)
    return {
        "miner_id": miner_id,
        "from_ts": from_ts,
        "to_ts": to_ts,
        "tier": tier,
        "metrics": rows,
    }


@app.get("/api/fleet/hashrate_history")
async def api_fleet_hashrate_history(
    minutes: int = 60,
    bucket_seconds: int = 60,
) -> dict:
    """Total fleet hashrate history aggregated by bucket.

    Default: last hour with 1-minute buckets → data points suitable for
    the "1-min average" chart on the home page. ``minutes`` is capped at
    24h to keep queries from getting huge.
    """
    import time as _time

    minutes = max(1, min(int(minutes), 24 * 60))
    bucket_seconds = max(10, min(int(bucket_seconds), 3600))
    to_ts = int(_time.time())
    from_ts = to_ts - minutes * 60
    points = await db.fleet_hashrate_buckets(from_ts, to_ts, bucket_seconds)
    return {
        "from_ts": from_ts,
        "to_ts": to_ts,
        "bucket_seconds": bucket_seconds,
        "points": points,
    }


@app.get("/api/fleet/block_finds")
async def api_fleet_block_finds(limit: int = 50) -> dict:
    """Return the list of block-found events for the whole fleet.

    Used by the home page to render the celebratory "Blocks found"
    card. Returns the most recent ``limit`` events newest-first; the
    UI typically shows them all (they're so rare that the list is
    short in any reasonable timeframe).
    """
    rows = await db.list_block_finds(limit=max(1, min(int(limit), 500)))
    return {"block_finds": rows}


@app.get("/api/fleet/best_difficulty")
async def api_fleet_best_difficulty() -> dict:
    """Return the fleet's top best-share record per scope.

    Output:
        {
          "session": {"miner_id", "miner_name", "value", "ts"} | None,
          "alltime": {...} | None
        }

    "session" is the best share since the last detected miner reboot
    on whichever device is currently leading. "alltime" is the best
    ever observed by MinerWatch — survives miner reboots, and even
    MinerWatch restarts, because it's persisted in our DB.
    """
    return await db.get_fleet_best_records()


@app.get("/api/miners/{miner_id}/best_difficulty")
async def api_miner_best_difficulty(miner_id: int) -> dict:
    """Per-miner session/all-time best-share records.

    Same shape as the fleet endpoint but scoped to one miner. Missing
    scopes return None (e.g. a brand-new miner with no shares yet).
    """
    miner = await db.get_miner(miner_id)
    if not miner:
        raise HTTPException(404, "miner not found")
    records = await db.get_miner_best_records(miner_id)
    return {
        "miner_id": miner_id,
        "miner_name": miner["name"],
        "session": records["session"],
        "alltime": records["alltime"],
    }


@app.get("/api/miners/{miner_id}/raw")
async def api_miner_raw(miner_id: int) -> dict:
    """Return the raw payload from the most recent poll.

    Handy for debugging when a field isn't being parsed correctly.
    """
    import json as _json

    miner = await db.get_miner(miner_id)
    if not miner:
        raise HTTPException(404, "miner not found")
    sample = poller.last_results.get(miner_id)
    last_metric = await db.latest_metric(miner_id)
    raw_from_db = None
    if last_metric and last_metric.get("raw"):
        try:
            raw_from_db = _json.loads(last_metric["raw"])
        except (ValueError, TypeError):
            raw_from_db = last_metric["raw"]
    return {
        "miner": {"id": miner["id"], "name": miner["name"], "family": miner["family"], "host": miner["host"]},
        "live_sample": asdict(sample) if sample else None,
        "raw_from_db": raw_from_db,
    }


def _capabilities(family: str) -> dict:
    cls = DRIVERS.get(family)
    if not cls:
        return {}
    return {
        "set_fan": cls.can_set_fan,
        "set_frequency": cls.can_set_frequency,
        "set_voltage": cls.can_set_voltage,
        "restart": cls.can_restart,
    }


# ---------- API: miner controls ----------

class FanPayload(BaseModel):
    percent: int = Field(..., ge=0, le=100)


class FreqPayload(BaseModel):
    mhz: int = Field(..., ge=100, le=2000)


class VoltagePayload(BaseModel):
    millivolts: int = Field(..., ge=800, le=2000)


async def _resolve_driver(miner_id: int):
    miner = await db.get_miner(miner_id)
    if not miner:
        raise HTTPException(404, "miner not found")
    cfg = get_config()
    return miner, driver_for_record(
        {**miner, "timeout": cfg.polling.request_timeout}
    )


@app.post("/api/miners/{miner_id}/control/fan")
async def api_set_fan(miner_id: int, payload: FanPayload) -> dict:
    miner, drv = await _resolve_driver(miner_id)
    if not drv.can_set_fan:
        raise HTTPException(400, f"family {miner['family']} does not support fan control")
    ok = await drv.set_fan_speed(payload.percent)
    if not ok:
        raise HTTPException(502, "the miner rejected the command")
    return {"ok": True}


@app.post("/api/miners/{miner_id}/control/frequency")
async def api_set_frequency(miner_id: int, payload: FreqPayload) -> dict:
    miner, drv = await _resolve_driver(miner_id)
    if not drv.can_set_frequency:
        raise HTTPException(400, f"family {miner['family']} does not support frequency control")
    ok = await drv.set_frequency(payload.mhz)
    if not ok:
        raise HTTPException(502, "the miner rejected the command")
    return {"ok": True}


@app.post("/api/miners/{miner_id}/control/voltage")
async def api_set_voltage(miner_id: int, payload: VoltagePayload) -> dict:
    miner, drv = await _resolve_driver(miner_id)
    if not drv.can_set_voltage:
        raise HTTPException(400, f"family {miner['family']} does not support voltage control")
    ok = await drv.set_voltage(payload.millivolts)
    if not ok:
        raise HTTPException(502, "the miner rejected the command")
    return {"ok": True}


@app.post("/api/miners/{miner_id}/control/restart")
async def api_restart(miner_id: int) -> dict:
    miner, drv = await _resolve_driver(miner_id)
    if not drv.can_restart:
        raise HTTPException(400, f"family {miner['family']} does not support restart via API")
    ok = await drv.restart()
    if not ok:
        raise HTTPException(502, "the miner rejected the command")
    return {"ok": True}


class FanConfigPayload(BaseModel):
    """Per-miner fan control configuration.

    fan_mode:
      - "manual"     → user sets a fixed percentage (`POST /control/fan`)
      - "firmware"   → delegate to the miner's firmware (Avalon `-1`, Bitaxe `autofanspeed=1`)
      - "minerwatch" → server-side PID that nudges the speed to keep
                       chip temp near `auto_target_c`
    """
    fan_mode: Optional[str] = None  # 'manual' | 'firmware' | 'minerwatch'
    auto_target_c: Optional[float] = None
    fan_min_override: Optional[int] = None
    fan_max_override: Optional[int] = None
    fan_threshold_c: Optional[float] = None


@app.post("/api/miners/{miner_id}/control/fan_config")
async def api_set_fan_config(miner_id: int, payload: FanConfigPayload) -> dict:
    miner = await db.get_miner(miner_id)
    if not miner:
        raise HTTPException(404, "miner not found")
    try:
        await db.set_fan_config(
            miner_id,
            fan_mode=payload.fan_mode,
            auto_target_c=payload.auto_target_c,
            fan_min_override=payload.fan_min_override,
            fan_max_override=payload.fan_max_override,
            fan_threshold_c=payload.fan_threshold_c,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    # If we just switched to "firmware", send the command to the miner
    # right away to keep state in sync. Bitaxe has set_auto_fan, Avalon
    # uses fan-spd,-1.
    if payload.fan_mode == "firmware":
        cfg = get_config()
        drv = driver_for_record({**miner, "timeout": cfg.polling.request_timeout})
        if hasattr(drv, "set_auto_fan"):
            try:
                await drv.set_auto_fan(True)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
    return {"ok": True}


@app.delete("/api/push/subscriptions/all")
async def api_purge_push_subscriptions() -> dict:
    """Remove ALL push subscriptions from the DB.

    Useful when you want to "turn everything off" server-side without
    visiting every single browser/tab that previously subscribed. The
    client-side SW will stop receiving pushes anyway (Chrome gets a 410
    from the push service and self-cleans).
    """
    n = await db.purge_push_subs()
    return {"ok": True, "removed": n}


# ---------- API: discovery ----------

class DiscoveryPayload(BaseModel):
    cidr: Optional[str] = None


@app.post("/api/discovery/scan")
async def api_scan(payload: Optional[DiscoveryPayload] = None) -> dict:
    cidr = payload.cidr if payload else None
    found = await scan_network(cidr=cidr)
    # Import into the DB
    for info in found:
        await db.upsert_miner(info)
    return {"found": found}


@app.post("/api/discovery/auto")
async def api_discovery_auto() -> dict:
    found = await discover_and_register()
    return {"registered": len(found), "miners": found}


# ---------- API: system (host metrics, Raspberry Pi focus) ----------

class SystemFanPayload(BaseModel):
    """Target PWM duty for the host fan (0..100 %)."""
    percent: int = Field(..., ge=0, le=100)


@app.get("/api/system/info")
async def api_system_info() -> dict:
    """Static host info — model, kernel, capabilities.

    Frontend uses ``is_raspberry`` to decide whether to show the
    "System" entry in the sidebar at all. Cheap call (everything is
    precomputed at import time), so the home page can call it once on
    load without measurable latency.
    """
    return system_info.host_info()


@app.get("/api/system/snapshot")
async def api_system_snapshot() -> dict:
    """All dynamic host stats in a single payload. Polled ~every 5 s."""
    return await system_info.snapshot_async(db_path=db_path())


@app.post("/api/system/fan")
async def api_system_set_fan(payload: SystemFanPayload) -> dict:
    """Drive the host fan to the given percent (0..100).

    Returns 400 if no controllable fan is present on this host (e.g.
    running on macOS, or on a Pi without the gpio-fan / pwm-fan kernel
    overlay configured). The UI hides the slider in that case, so this
    is mostly belt-and-braces for direct API users.
    """
    try:
        return await system_info.set_fan_percent_async(payload.percent)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


# ---------- API: alerts ----------

@app.get("/api/alerts")
async def api_alerts(only_unack: bool = False, limit: int = 200) -> dict:
    rows = await db.list_alerts(limit=limit, only_unack=only_unack)
    return {"alerts": rows}


@app.post("/api/alerts/{alert_id}/ack")
async def api_alert_ack(alert_id: int) -> dict:
    await db.ack_alert(alert_id)
    return {"ok": True}


# ---------- API: settings ----------

class SettingsPayload(BaseModel):
    """Runtime overrides stored in the DB.

    Keys follow the dotted config path, e.g.:
      ``polling.interval_seconds``, ``alerts.temp_chip_threshold``,
      ``auth.enabled``, ``auth.password``, ``storage.retention_days``.
    """

    overrides: Dict[str, Any]


@app.get("/api/settings")
async def api_get_settings() -> dict:
    cfg = get_config()
    # ``asdict(cfg.alerts)`` would echo back the Telegram bot token in
    # plain text — same risk we already avoid for ``auth.password``.
    # Replace it with a boolean flag so the UI can show "✓ configured"
    # without ever revealing the secret.
    alerts_view = asdict(cfg.alerts)
    alerts_view["telegram_token_set"] = bool(alerts_view.pop("telegram_bot_token", "").strip())
    # Sanitize the raw stored map too: anything sensitive (password,
    # bot token) gets stripped here. Existing callers don't rely on
    # these specific keys being present.
    stored = {
        k: v
        for k, v in (await db.all_settings()).items()
        if k not in {"auth.password", "alerts.telegram_bot_token"}
    }
    return {
        "current": {
            "polling": asdict(cfg.polling),
            "alerts": alerts_view,
            "storage": asdict(cfg.storage),
            "network": asdict(cfg.network),
            "auth_enabled": cfg.auth.enabled,
        },
        "stored": stored,
    }


@app.post("/api/settings")
async def api_post_settings(payload: SettingsPayload) -> dict:
    cfg = get_config()
    for key, value in payload.overrides.items():
        await db.set_setting(key, str(value))
    cfg.apply_overrides(payload.overrides)
    return {"ok": True}


@app.post("/api/settings/reload")
async def api_settings_reload() -> dict:
    cfg = reload_config()
    overrides = await db.all_settings()
    cfg.apply_overrides({k: v for k, v in overrides.items() if not k.startswith("_")})
    return {"ok": True}


# ---------- API: auth ----------

class LoginPayload(BaseModel):
    password: str


@app.get("/api/auth/status")
async def api_auth_status() -> dict:
    cfg = get_config()
    return {"enabled": cfg.auth.enabled}


@app.post("/api/auth/login")
async def api_auth_login(
    payload: LoginPayload,
    request: Request,
    response: Response,
) -> dict:
    cfg = get_config()
    if not cfg.auth.enabled:
        return {"ok": True, "auth_disabled": True}

    expected = (cfg.auth.password or "").strip()
    if not expected:
        # Same fail-closed posture as require_auth(): if auth is on but
        # no password is configured we refuse every login attempt instead
        # of letting an empty password match via compare_digest("", "").
        raise HTTPException(
            status_code=401,
            detail="Authentication is enabled but no password is configured",
        )

    # Per-IP rate-limit: a small in-memory counter that locks out a
    # client after LOGIN_FAIL_THRESHOLD consecutive wrong attempts. Keeps
    # brute force on the LAN to a crawl without making typos painful.
    ip = request.client.host if request.client else "unknown"
    remaining = login_lockout_remaining(ip)
    if remaining > 0:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed attempts. Try again in {int(remaining) + 1}s.",
        )

    provided = payload.password or ""
    if not hmac.compare_digest(provided, expected):
        wait = record_login_failure(ip)
        if wait > 0:
            # Just tripped the threshold — surface a 429 so the UI shows
            # the user a useful "locked for N seconds" message instead of
            # a generic "wrong password".
            raise HTTPException(
                status_code=429,
                detail=f"Too many failed attempts. Locked for {int(wait) + 1}s.",
            )
        raise HTTPException(401, "incorrect password")

    # Success — wipe the failure counter for this IP so the next typo
    # doesn't start halfway to a lockout.
    clear_login_failures(ip)

    # Explicit path="/" and a 30-day max_age. The Starlette default is
    # already path="/", but being explicit makes the intent obvious and
    # avoids surprises if a future version changes the default. max_age
    # promotes the cookie from a "session cookie" (which iOS Safari can
    # drop more eagerly) to a persistent one, so users don't have to log
    # in again every time the browser is restarted.
    response.set_cookie(
        "mw_token",
        payload.password,
        httponly=True,
        samesite="lax",
        path="/",
        max_age=60 * 60 * 24 * 30,
    )
    return {"ok": True}


@app.post("/api/auth/logout")
async def api_auth_logout(response: Response) -> dict:
    response.delete_cookie("mw_token", path="/")
    return {"ok": True}


# ---------- API: push (Web Push) ----------

class PushSubscription(BaseModel):
    endpoint: str
    keys: Dict[str, str]


@app.get("/api/push/vapid_public_key")
async def api_push_pub_key() -> dict:
    return {"public_key": public_key_b64()}


@app.post("/api/push/subscribe")
async def api_push_subscribe(sub: PushSubscription, request: Request) -> dict:
    p256dh = sub.keys.get("p256dh", "")
    auth_key = sub.keys.get("auth", "")
    if not (sub.endpoint and p256dh and auth_key):
        raise HTTPException(400, "invalid subscription")
    ua = request.headers.get("user-agent")
    await db.add_push_sub(sub.endpoint, p256dh, auth_key, ua)
    return {"ok": True}


@app.delete("/api/push/subscribe")
async def api_push_unsubscribe(payload: dict) -> dict:
    endpoint = payload.get("endpoint")
    if not endpoint:
        raise HTTPException(400, "missing endpoint")
    await db.remove_push_sub(endpoint)
    return {"ok": True}


@app.post("/api/push/test")
async def api_push_test() -> dict:
    """Send a test notification to all registered clients.

    Handy to verify that the push flow works end-to-end without
    having to wait for a real alert.
    """
    from . import alerts as _alerts
    from . import db as _db

    subs = await _db.list_push_subs()
    if not subs:
        raise HTTPException(
            status_code=400,
            detail="No browser is subscribed to push. Open 'Enable notifications' in Settings.",
        )
    await _alerts.send_push(
        {
            "title": "MinerWatch · test",
            "body": "Notifications are working! 🎉",
            "miner_id": None,
        }
    )
    return {"ok": True, "subscribers": len(subs)}


# ---------- API: Telegram ----------

@app.post("/api/telegram/test")
async def api_telegram_test() -> dict:
    """Send a test message to the configured Telegram chat.

    Mirrors ``/api/push/test``: confirms end-to-end that bot token and
    chat_id are valid without waiting for a real alert. Returns the
    error description from Telegram (if any) so the UI can show it.
    """
    from . import alerts as _alerts

    ok, detail = await _alerts.send_telegram(
        {
            "title": "MinerWatch · test",
            "body": "Telegram notifications are working! 🎉",
        }
    )
    if not ok:
        # 400 keeps the same convention as /api/push/test for "you need
        # to configure things first".
        raise HTTPException(status_code=400, detail=detail)
    return {"ok": True}


@app.get("/api/telegram/discover_chat_id")
async def api_telegram_discover_chat_id() -> dict:
    """Help the user find the chat_id for the currently-configured bot.

    Calls Telegram's ``getUpdates`` and extracts the distinct chats
    seen recently. The user just sent ``/start`` to the bot from their
    phone — the chat shows up here, they click it in the UI and the
    chat_id field gets populated automatically.

    Note: Telegram drops updates after ~24h, and ``getUpdates`` is
    incompatible with webhooks. We never set a webhook so this is
    safe to call repeatedly.
    """
    from . import alerts as _alerts

    raw = await _alerts.telegram_get_updates()
    if not raw.get("ok"):
        # Surface both our own errors (missing token, network) and
        # Telegram's (invalid token → "Unauthorized") to the UI.
        error = raw.get("error") or raw.get("description") or "unknown error"
        raise HTTPException(status_code=400, detail=error)

    seen: dict[str, dict[str, Any]] = {}
    for update in raw.get("result", []):
        # Telegram messages can come as ``message``, ``edited_message``,
        # ``channel_post``, etc. We unify all of them.
        msg = (
            update.get("message")
            or update.get("edited_message")
            or update.get("channel_post")
            or update.get("my_chat_member")
        )
        if not isinstance(msg, dict):
            continue
        chat = msg.get("chat") or {}
        cid = chat.get("id")
        if cid is None:
            continue
        key = str(cid)
        if key in seen:
            continue
        # Build a human-friendly label: prefer username, then first/last
        # name, then chat title for groups. Fall back to the raw id.
        username = chat.get("username")
        first = chat.get("first_name")
        last = chat.get("last_name")
        title = chat.get("title")
        ctype = chat.get("type") or "?"
        if title:
            label = f"{title} ({ctype})"
        elif first or last:
            full = " ".join(p for p in (first, last) if p)
            label = f"{full}" + (f" @{username}" if username else "")
        elif username:
            label = f"@{username}"
        else:
            label = key
        seen[key] = {"chat_id": key, "label": label, "type": ctype}

    return {"ok": True, "chats": list(seen.values())}



