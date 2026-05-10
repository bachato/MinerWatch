# SPDX-License-Identifier: AGPL-3.0-only
"""MinerWatch FastAPI entrypoint.

Run:
    uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

The ``start.sh`` script in the repo root does exactly this after
setting up the virtualenv.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db
from .alerts import ensure_vapid_keys, public_key_b64
from .auth import public_paths, require_auth
from .auto_control import auto_fan
from .config import FRONTEND_DIR, get_config, reload_config
from .discovery import discover_and_register, scan_network
from .miners import DRIVERS, driver_for_record
from .poller import poller

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("minerwatch")

app = FastAPI(title="MinerWatch", version="0.1.0")

# CORS open: on a home LAN we want it to work from any device
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
            # For API requests return 401 JSON; for HTML pages redirect to login
            if path.startswith("/api/"):
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
            return FileResponse(FRONTEND_DIR / "login.html")
    return await call_next(request)


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
    return {
        "current": {
            "polling": asdict(cfg.polling),
            "alerts": asdict(cfg.alerts),
            "storage": asdict(cfg.storage),
            "network": asdict(cfg.network),
            "auth_enabled": cfg.auth.enabled,
        },
        "stored": await db.all_settings(),
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
async def api_auth_login(payload: LoginPayload, response: Response) -> dict:
    cfg = get_config()
    if not cfg.auth.enabled:
        return {"ok": True, "auth_disabled": True}
    if payload.password != cfg.auth.password:
        raise HTTPException(401, "incorrect password")
    response.set_cookie("mw_token", payload.password, httponly=True, samesite="lax")
    return {"ok": True}


@app.post("/api/auth/logout")
async def api_auth_logout(response: Response) -> dict:
    response.delete_cookie("mw_token")
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


