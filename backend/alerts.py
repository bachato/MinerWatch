# SPDX-License-Identifier: AGPL-3.0-only
"""Alert system + Web Push (VAPID).

Logic:
- On every polling cycle :func:`evaluate` receives the current samples.
- For each miner we check thresholds (chip / VR temp) and online↔offline
  transitions (based on the timestamp of the last successful poll).
- If the state changed compared to the previous cycle, we log an alert
  in the DB and send a push notification to every registered client.

VAPID:
- Keys are generated on first startup at ``data/vapid_keys.json``
  (P-256 curve per RFC 8292).
- The public endpoint ``/api/push/vapid_public_key`` returns the public
  key the browser needs to subscribe.
"""
from __future__ import annotations

import base64
import json
import logging
import time
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

from .config import get_config, vapid_keys_path
from . import db
from .miners.base import MinerSample

log = logging.getLogger("minerwatch.alerts")

# In-memory state: for each miner, the last reported state/temperature,
# to avoid duplicating notifications every 5 seconds.
_state: dict[int, dict[str, Any]] = {}

# Anti-spam tuning for best-share notifications.
# - Skip the very first record we ever observe for a miner: a brand-new
#   miner sets a "best" on its very first share, which would just be noise.
# - Require the new value to beat the previous all-time by at least
#   BEST_SHARE_MIN_GROWTH (10%). Without this, every consecutive share
#   slightly above the previous one would push, which is a lot.
# - Cool-down per miner: never push more than once every BEST_SHARE_COOLDOWN_S
#   seconds, no matter what.
BEST_SHARE_MIN_GROWTH = 1.10
BEST_SHARE_COOLDOWN_S = 60

# py-vapid validates this field with a strict regex: it must be
# "mailto:<something>@localhost" or "mailto:<something>@<domain.tld>".
# "@local" without a dot fails with "Missing 'sub' from claims".
VAPID_CLAIMS_EMAIL = "mailto:minerwatch@localhost"


# ---------- VAPID keys ----------

def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def ensure_vapid_keys() -> dict[str, str]:
    path = vapid_keys_path()
    if path.exists():
        try:
            keys = json.loads(path.read_text("utf-8"))
            # File already exists: make sure private_b64 is present
            # (older versions might only have private_pem).
            if "private_b64" in keys and "public_b64" in keys:
                return keys
        except (ValueError, OSError):
            pass

    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    priv_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")

    public_numbers = public_key.public_numbers()
    x = public_numbers.x.to_bytes(32, "big")
    y = public_numbers.y.to_bytes(32, "big")
    pub_b64 = _b64(b"\x04" + x + y)

    priv_int = private_key.private_numbers().private_value
    priv_b64 = _b64(priv_int.to_bytes(32, "big"))

    keys = {
        "private_pem": priv_pem,
        "private_b64": priv_b64,
        "public_b64": pub_b64,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(keys, indent=2), encoding="utf-8")
    log.info("VAPID keys generated at %s", path)
    return keys


def public_key_b64() -> str:
    return ensure_vapid_keys()["public_b64"]


def private_key_pem() -> str:
    return ensure_vapid_keys()["private_pem"]


def private_key_b64() -> str:
    """Private key in urlsafe-base64 format (raw 32 bytes).

    Used instead of the PEM to dodge a LibreSSL bug on macOS:
    'header too long' when cryptography tries to re-parse the PEM.
    py-vapid accepts this form directly via Vapid01.from_raw().
    """
    return ensure_vapid_keys()["private_b64"]


# ---------- Push send ----------

async def send_push(payload: dict[str, Any]) -> None:
    import asyncio as _aio

    # Global kill-switch: if the user set notifications_enabled=False
    # in Settings, return immediately without sending anything. The
    # subscriptions stay in the DB so when re-enabled it just works
    # again without the user having to re-subscribe each browser.
    cfg = get_config()
    if not cfg.alerts.notifications_enabled:
        log.info(
            "push: notifications_enabled=False → notification '%s' silenced",
            payload.get("title", ""),
        )
        return

    subs = await db.list_push_subs()
    if not subs:
        log.info("push: no subscribers registered (no notification sent)")
        return
    # We use the RAW base64 key instead of the PEM: pywebpush feeds it
    # to Vapid01.from_raw(), bypassing cryptography's PEM parser (which
    # on LibreSSL macOS yields "header too long").
    priv = private_key_b64()
    body = json.dumps(payload)
    log.info("push: sending to %d subscriber(s) | %s", len(subs), payload.get("title", ""))

    def _send_one(sub_info: dict, body: str) -> tuple[int, str]:
        """Run synchronous webpush in a worker thread. Returns (status, message)."""
        try:
            resp = webpush(
                subscription_info=sub_info,
                data=body,
                vapid_private_key=priv,
                vapid_claims={"sub": VAPID_CLAIMS_EMAIL},
            )
            status = getattr(resp, "status_code", 0)
            return (status, f"OK status={status}")
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", 0)
            return (status, f"WebPushException: {exc}")
        except Exception as exc:  # noqa: BLE001
            return (0, f"Exception: {type(exc).__name__}: {exc}")

    for sub in subs:
        sub_info = {
            "endpoint": sub["endpoint"],
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
        }
        endpoint_short = sub["endpoint"][:70] + "..." if len(sub["endpoint"]) > 70 else sub["endpoint"]
        status, message = await _aio.to_thread(_send_one, sub_info, body)
        log.info("push -> %s : %s", endpoint_short, message)
        if status in (404, 410):
            log.info("push: subscription expired, removing from DB")
            await db.remove_push_sub(sub["endpoint"])


# ---------- Logic ----------

async def evaluate(samples: dict[int, MinerSample]) -> None:
    cfg = get_config()
    now = int(time.time())
    miners_by_id = {m["id"]: m for m in await db.list_miners()}
    repeat_s = max(60, int(cfg.alerts.repeat_seconds))

    for miner_id, sample in samples.items():
        info = miners_by_id.get(miner_id, {})
        miner_name = info.get("name") or sample.host
        prev = _state.get(miner_id, {})
        new_state: dict[str, Any] = dict(prev)

        # Online/offline transitions
        was_online = prev.get("online", True)
        new_state["online"] = sample.online

        if sample.online:
            new_state["last_online_ts"] = now
            if not was_online:
                msg = f"{miner_name} is back online"
                await db.insert_alert(miner_id, "info", "recovered", msg)
                await send_push({"title": "Miner online", "body": msg, "miner_id": miner_id})
        else:
            last_online = prev.get("last_online_ts", now)
            offline_for = now - last_online
            last_offline_alert = prev.get("last_offline_alert_ts", 0)
            if offline_for >= cfg.alerts.offline_threshold_seconds and (
                not prev.get("offline_alerted") or (now - last_offline_alert) >= repeat_s
            ):
                msg = f"{miner_name} has not responded for {offline_for}s"
                await db.insert_alert(miner_id, "warning", "offline", msg)
                await send_push({"title": "Miner offline", "body": msg, "miner_id": miner_id})
                new_state["offline_alerted"] = True
                new_state["last_offline_alert_ts"] = now

            _state[miner_id] = new_state
            continue

        # Reset offline flag once it is back online
        new_state.pop("offline_alerted", None)
        new_state.pop("last_offline_alert_ts", None)

        # ----- Chip temperature threshold -----
        chip_threshold = info.get("fan_threshold_c") or cfg.alerts.temp_chip_threshold
        if sample.temp_chip_c is not None and sample.temp_chip_c >= chip_threshold:
            last_chip_alert = prev.get("last_chip_alert_ts", 0)
            should_alert = (
                not prev.get("chip_alerted")
                or (now - last_chip_alert) >= repeat_s
            )
            if should_alert:
                msg = (
                    f"{miner_name}: chip temperature {sample.temp_chip_c:.1f}°C "
                    f"(threshold {chip_threshold}°C)"
                )
                await db.insert_alert(miner_id, "critical", "temp_chip", msg)
                await send_push({"title": "High chip temp", "body": msg, "miner_id": miner_id})
                new_state["chip_alerted"] = True
                new_state["last_chip_alert_ts"] = now
        else:
            new_state.pop("chip_alerted", None)
            new_state.pop("last_chip_alert_ts", None)

        # ----- VR temperature threshold -----
        if sample.temp_vr_c is not None and sample.temp_vr_c >= cfg.alerts.temp_vr_threshold:
            last_vr_alert = prev.get("last_vr_alert_ts", 0)
            should_alert = (
                not prev.get("vr_alerted")
                or (now - last_vr_alert) >= repeat_s
            )
            if should_alert:
                msg = (
                    f"{miner_name}: VR temperature {sample.temp_vr_c:.1f}°C "
                    f"(threshold {cfg.alerts.temp_vr_threshold}°C)"
                )
                await db.insert_alert(miner_id, "critical", "temp_vr", msg)
                await send_push({"title": "High VR temp", "body": msg, "miner_id": miner_id})
                new_state["vr_alerted"] = True
                new_state["last_vr_alert_ts"] = now
        else:
            new_state.pop("vr_alerted", None)
            new_state.pop("last_vr_alert_ts", None)

        _state[miner_id] = new_state


# ---------- Best-share notifications ----------

def _format_si_difficulty(value: float, decimals: int = 2) -> str:
    """Compact SI representation of a raw difficulty number.

    Mirrors the frontend ``fmtDifficulty`` so the push body shows the
    same format users see in the UI (e.g. ``4.29 G``).
    """
    if value is None:
        return "—"
    n = float(value)
    if n == 0:
        return "0"
    units = (
        (1e24, "Y"),
        (1e21, "Z"),
        (1e18, "E"),
        (1e15, "P"),
        (1e12, "T"),
        (1e9, "G"),
        (1e6, "M"),
        (1e3, "k"),
    )
    abs_n = abs(n)
    for v, s in units:
        if abs_n >= v:
            return f"{n / v:.{decimals}f} {s}"
    return f"{n:.0f}"


async def notify_new_alltime_best(
    miner_id: int,
    miner_name: str,
    prev_value: float | None,
    new_value: float,
    ts: int,
) -> bool:
    """Maybe send a "new best share" push for a freshly-broken all-time record.

    Returns ``True`` if a notification was actually emitted, ``False`` if
    it was suppressed by one of the anti-spam guards.

    Suppression rules (all evaluated; first that matches wins):
      1. ``prev_value is None`` — first record ever for this miner; we
         silently seed it without notifying.
      2. ``new_value < prev_value * BEST_SHARE_MIN_GROWTH`` — the bump
         is too small to be interesting (< +10% by default).
      3. The miner emitted a best-share push in the last
         ``BEST_SHARE_COOLDOWN_S`` seconds.
    """
    state = _state.setdefault(miner_id, {})

    if prev_value is None:
        # Seed: remember we've seen one record so future bumps qualify.
        state["best_share_alltime_seeded_ts"] = ts
        return False

    if new_value < float(prev_value) * BEST_SHARE_MIN_GROWTH:
        return False

    last_push = state.get("best_share_alltime_last_push_ts", 0)
    if ts - last_push < BEST_SHARE_COOLDOWN_S:
        return False

    pretty_new = _format_si_difficulty(new_value)
    pretty_prev = _format_si_difficulty(prev_value)
    title = "🎯 New best share"
    body = f"{miner_name}: {pretty_new} (was {pretty_prev})"
    await db.insert_alert(miner_id, "info", "best_share_alltime", body)
    await send_push({
        "title": title,
        "body": body,
        "miner_id": miner_id,
        "code": "best_share_alltime",
    })

    state["best_share_alltime_last_push_ts"] = ts
    return True
