# SPDX-License-Identifier: AGPL-3.0-only
"""Guardian — a runtime frequency governor for AxeOS miners (Bitaxe / Nerd*).

This is a continuous, *slow* control loop. It is a twin of the server-side
auto-fan PID in ``auto_control.py``, but acts on a different lever and a
different sensor:

  - the auto-fan PID is the FAST inner loop (5 s): it modulates the FAN to
    hold the CHIP temperature near a target;
  - the Guardian is the SLOW outer loop (default 5 min): it nudges the ASIC
    FREQUENCY to keep the VR (voltage-regulator) temperature and the HW
    error rate inside safe bounds, recovering frequency when things cool.

Nothing else in MinerWatch governs the VR in a closed loop — the fan PID
and the 75 °C overheat watchdog both watch the *chip*. The VR is frequently
the real bottleneck, so a VR-driven frequency governor fills a genuine gap
rather than duplicating the fan logic. The two loops reinforce each other:
when the VR gets hot the Guardian cuts frequency → less power → the VR
*and* the chip cool → the fan PID eases off.

Control law (v1, frequency-only), evaluated once per ``interval_seconds``:

    VR temp  > vr_high_c        → frequency − step_down_vr_mhz   (safety)
    HW err % > hw_error_pct_max → frequency − step_down_err_mhz  (safety)
    VR temp  < vr_low_c         → frequency + step_up_mhz        (recover)
    otherwise (deadband)        → hold

Down-actions (safety) take priority over the upward recovery, and every
result is clamped to the per-miner ``[floor, ceiling]``. The ceiling is the
user's "max frequency" — by default the miner's current frequency at the
moment the Guardian is enabled, but editable for expert users.

Why the cadence is the safety knob: AxeOS applies a frequency change LIVE
(no reboot — confirmed for both Bitaxe and Nerd*), so there is no downtime
cost per nudge. The limiting factor is instead the VR's *thermal inertia*:
after a change the VR keeps drifting for a minute or two. Ticking faster
than that would mean acting on a reading that hasn't finished responding,
which causes hunting. So the loop runs on a long interval (≥ the VR settle
time), and an optional ``cooldown_seconds`` can enforce extra settle time.

NVS wear: a frequency PATCH persists to the ESP32's flash. The governor
only writes when the target *differs* from the live frequency, so inside the
65–70 °C deadband it parks on an equilibrium frequency and stops writing.

Reversibility: this is an additive bolt-on. It lives in this module, reads
``poller.last_results``, uses only driver methods that already exist
(``set_frequency`` / ``poll``) and three per-miner columns on the ``miners``
table. It never changes voltage in v1 (see the v2 notes below and in
docs/guardian-design.md).

v2 (not active here): AxeOS also applies *voltage* changes live, which opens
a second lever — respond to sustained HW errors by RAISING coreVoltage (the
proper fix for undervolt instability) instead of only cutting frequency, and
optionally lower voltage alongside frequency cuts to preserve J/TH. Auto-
raising voltage 24/7 unattended is riskier (more heat/watts, closer to the
hardware limits), so it stays out of v1. The decision function and the
config carry the seams for it; see ``GuardianCfg.v2_*`` and the design doc.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from . import db
from .config import get_config
from .miners import driver_for_record
from .miners.base import MinerSample

log = logging.getLogger("minerwatch.guardian")

# Families this governor knows how to drive. Both speak the AxeOS REST API
# and expose ``vrTemp``; the VR temperature is the primary control signal.
GUARDIAN_FAMILIES = ("bitaxe", "nerdoctaxe")


# ============================================================================
# Pure decision function (no I/O — unit-tested in tests/test_guardian.py)
# ============================================================================

def decide_frequency(
    *,
    current_freq: int,
    ceiling_mhz: int,
    floor_mhz: int,
    vr_temp_c: float | None,
    hw_error_pct: float | None,
    vr_high_c: float,
    vr_low_c: float,
    hw_error_pct_max: float,
    step_down_vr_mhz: int,
    step_down_err_mhz: int,
    step_up_mhz: int,
) -> tuple[int, str]:
    """Decide the next frequency for one miner.

    Returns ``(target_freq_mhz, reason)``. ``target_freq_mhz == current_freq``
    means "hold" (the caller then writes nothing, sparing NVS). The function
    is deliberately pure so the policy can be reasoned about and tested in
    isolation from the driver/poller plumbing.

    Sensor values may be ``None`` (sensor absent or, for HW%, not yet
    computable / no work denominator). A ``None`` simply disables the branch
    that depends on it — e.g. with no VR reading the governor won't move on
    temperature, and on Nerd* (no usable error denominator) the error branch
    is skipped and VR governs alone.
    """
    # Defensive: a mis-set floor above the ceiling must not brick the loop.
    if floor_mhz > ceiling_mhz:
        floor_mhz = ceiling_mhz

    # 0. Enforce the per-miner ceiling/floor first, regardless of sensors.
    #    The ceiling is the user's "max frequency": never run above it (e.g.
    #    if the user manually overclocked past the cap, pull it back down).
    if current_freq > ceiling_mhz:
        return ceiling_mhz, f"above max {ceiling_mhz} MHz → cap to ceiling"
    if current_freq < floor_mhz:
        return floor_mhz, f"below floor {floor_mhz} MHz → raise to floor"

    # 1..3 — the control law. Order encodes the priority: back off on heat,
    # then on instability, and only otherwise try to recover frequency.
    if vr_temp_c is not None and vr_temp_c > vr_high_c:
        target = current_freq - step_down_vr_mhz
        reason = f"VR {vr_temp_c:.1f}°C > {vr_high_c:.0f}°C → -{step_down_vr_mhz} MHz"
    elif hw_error_pct is not None and hw_error_pct > hw_error_pct_max:
        target = current_freq - step_down_err_mhz
        reason = (
            f"HW err {hw_error_pct:.2f}% > {hw_error_pct_max:.2f}% "
            f"→ -{step_down_err_mhz} MHz"
        )
    elif vr_temp_c is not None and vr_temp_c < vr_low_c:
        target = current_freq + step_up_mhz
        reason = f"VR {vr_temp_c:.1f}°C < {vr_low_c:.0f}°C → +{step_up_mhz} MHz"
    else:
        return current_freq, "hold (within deadband)"

    target = max(floor_mhz, min(ceiling_mhz, target))
    if target == current_freq:
        # The desired move was clamped away by a limit (already at floor on a
        # down-step, or at ceiling on an up-step).
        return current_freq, "hold (at limit)"
    return target, reason


# ============================================================================
# Per-miner state
# ============================================================================

class _GuardianState:
    """Mutable per-miner state the loop carries between ticks."""

    __slots__ = (
        "prev_hw_errors",
        "prev_hw_total",
        "last_commanded_freq",
        "last_change_ts",
        "last_reason",
        "last_ts",
        "last_vr_c",
        "last_hw_pct",
    )

    def __init__(self) -> None:
        self.prev_hw_errors: int | None = None
        self.prev_hw_total: int | None = None
        self.last_commanded_freq: int | None = None
        self.last_change_ts: float = 0.0
        self.last_reason: str | None = None
        self.last_ts: float = 0.0
        self.last_vr_c: float | None = None
        self.last_hw_pct: float | None = None


def _hw_error_pct(state: _GuardianState, sample: MinerSample) -> float | None:
    """HW error % over the interval = Δerrors / Δwork × 100, or None.

    Uses the delta of the firmware's monotonic counters between this tick and
    the previous one. Returns None on the first tick (no baseline yet), on a
    counter reset (miner rebooted), or when there's no usable work denominator
    (Nerd* exposes only ``duplicateHWNonces`` with ``hw_total`` zeroed). The
    caller treats None as "error term inactive — VR governs alone".

    Side effect: advances the stored baseline to the current counters.
    """
    errs = sample.hw_errors
    total = sample.hw_total
    prev_e = state.prev_hw_errors
    prev_t = state.prev_hw_total

    pct: float | None = None
    if (
        errs is not None and total is not None
        and prev_e is not None and prev_t is not None
        and errs >= prev_e and total >= prev_t  # guard against counter resets
    ):
        d_err = errs - prev_e
        d_tot = total - prev_t
        if d_tot > 0:
            pct = (d_err / d_tot) * 100.0

    # Advance the baseline (also resets cleanly after a detected reset).
    state.prev_hw_errors = errs
    state.prev_hw_total = total
    return pct


# ============================================================================
# Guardian controller (one slow loop for the whole fleet)
# ============================================================================

class GuardianController:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._states: dict[int, _GuardianState] = {}
        # Live status per miner, surfaced by the API/UI.
        self._status: dict[int, dict[str, Any]] = {}
        self.last_tick_ts: float = 0.0

    # ---- lifecycle (mirrors AutoFanController) ----

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="minerwatch-guardian")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
        self._task = None

    def status(self, miner_id: int) -> dict[str, Any] | None:
        return self._status.get(int(miner_id))

    # ---- main loop ----

    async def _run(self) -> None:
        cfg = get_config().guardian
        log.info(
            "Guardian started — interval=%ds VR>%.0f°C −%dMHz / HW%%>%.2f −%dMHz "
            "/ VR<%.0f°C +%dMHz, floor=%dMHz",
            cfg.interval_seconds, cfg.vr_high_c, cfg.step_down_vr_mhz,
            cfg.hw_error_pct_max, cfg.step_down_err_mhz,
            cfg.vr_low_c, cfg.step_up_mhz, cfg.frequency_floor_mhz,
        )
        from .poller import poller as _poller

        while not self._stop.is_set():
            try:
                if get_config().guardian.enabled:
                    await self._tick(_poller.last_results)
            except Exception:  # noqa: BLE001
                log.exception("guardian tick error")
            # Re-read the interval each loop so a settings change takes effect
            # without a restart.
            interval = max(30, int(get_config().guardian.interval_seconds))
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                continue
        log.info("Guardian stopped")

    async def _tick(self, samples: dict[int, MinerSample]) -> None:
        self.last_tick_ts = time.time()
        cfg = get_config()
        gcfg = cfg.guardian
        miners = await db.list_miners(only_enabled=True)
        seen: set[int] = set()

        for miner in miners:
            miner_id = int(miner["id"])
            if not _coerce_bool(miner.get("guardian_enabled")):
                continue
            family = (miner.get("family") or "").lower()
            if family not in GUARDIAN_FAMILIES:
                continue
            sample = samples.get(miner_id)
            if sample is None or not sample.online:
                continue
            seen.add(miner_id)
            try:
                await self._govern_one(miner, sample, gcfg, cfg)
            except Exception:  # noqa: BLE001
                log.exception("guardian: miner=%s govern error", miner.get("name"))

        # Drop state for miners no longer governed/online so a returning miner
        # starts with a fresh HW% baseline instead of a stale delta.
        for mid in list(self._states):
            if mid not in seen:
                self._states.pop(mid, None)
        for mid in list(self._status):
            if mid not in seen:
                self._status.pop(mid, None)

    async def _govern_one(self, miner: dict, sample: MinerSample, gcfg, cfg) -> None:
        miner_id = int(miner["id"])
        state = self._states.get(miner_id)
        if state is None:
            state = _GuardianState()
            self._states[miner_id] = state

        # Current frequency: trust the live sample; fall back to what we last
        # commanded if the firmware didn't report it this poll.
        current_freq = (
            int(sample.frequency_mhz)
            if sample.frequency_mhz
            else state.last_commanded_freq
        )

        # HW% over the interval (advances the baseline as a side effect).
        hw_pct = _hw_error_pct(state, sample)
        vr_c = sample.temp_vr_c

        # Always record the latest reading for the status endpoint, even if we
        # can't act this tick.
        now = time.time()
        state.last_ts = now
        state.last_vr_c = vr_c
        state.last_hw_pct = hw_pct

        if current_freq is None:
            # Can't govern without knowing the frequency.
            self._publish(miner_id, miner, current_freq, vr_c, hw_pct,
                          "no frequency reading", changed=False)
            return

        # Resolve the per-miner ceiling/floor.
        #   ceiling = the user's "max frequency". If unset (Guardian enabled
        #   out-of-band without a cap), fall back to the current freq so the
        #   governor can only hold/back off, never push up past an unknown cap.
        ceiling = miner.get("guardian_max_freq_mhz")
        ceiling = int(ceiling) if ceiling else int(current_freq)
        floor = miner.get("guardian_freq_floor_mhz")
        floor = int(floor) if floor else int(gcfg.frequency_floor_mhz)

        target, reason = decide_frequency(
            current_freq=int(current_freq),
            ceiling_mhz=ceiling,
            floor_mhz=floor,
            vr_temp_c=vr_c,
            hw_error_pct=hw_pct,
            vr_high_c=gcfg.vr_high_c,
            vr_low_c=gcfg.vr_low_c,
            hw_error_pct_max=gcfg.hw_error_pct_max,
            step_down_vr_mhz=gcfg.step_down_vr_mhz,
            step_down_err_mhz=gcfg.step_down_err_mhz,
            step_up_mhz=gcfg.step_up_mhz,
        )

        if target == int(current_freq):
            # Nothing to do — don't touch the miner (no NVS write).
            self._publish(miner_id, miner, current_freq, vr_c, hw_pct,
                          reason, changed=False, ceiling=ceiling, floor=floor)
            return

        # Optional cooldown: enforce extra settle time between changes.
        cooldown = int(gcfg.cooldown_seconds or 0)
        if cooldown > 0 and (now - state.last_change_ts) < cooldown:
            self._publish(miner_id, miner, current_freq, vr_c, hw_pct,
                          f"cooldown ({reason})", changed=False,
                          ceiling=ceiling, floor=floor)
            return

        # Apply the change (live — no restart on AxeOS).
        drv = driver_for_record({**miner, "timeout": cfg.polling.request_timeout})
        if not drv.can_set_frequency:
            return
        try:
            ok = await drv.set_frequency(int(target))
        except Exception as exc:  # noqa: BLE001
            log.warning("guardian: miner=%s set_frequency failed: %s",
                        miner.get("name"), exc)
            self._publish(miner_id, miner, current_freq, vr_c, hw_pct,
                          f"set_frequency failed: {exc}", changed=False,
                          ceiling=ceiling, floor=floor)
            return
        if ok:
            state.last_commanded_freq = int(target)
            state.last_change_ts = now
            state.last_reason = reason
            log.info(
                "guardian: miner=%s %d→%d MHz (%s) [VR=%s HW%%=%s ceiling=%d floor=%d]",
                miner.get("name"), int(current_freq), int(target), reason,
                f"{vr_c:.1f}" if vr_c is not None else "n/a",
                f"{hw_pct:.2f}" if hw_pct is not None else "n/a",
                ceiling, floor,
            )
            self._publish(miner_id, miner, target, vr_c, hw_pct, reason,
                          changed=True, ceiling=ceiling, floor=floor)
        else:
            log.warning("guardian: miner=%s rejected set_frequency(%d)",
                        miner.get("name"), int(target))

    def _publish(
        self,
        miner_id: int,
        miner: dict,
        freq: int | None,
        vr_c: float | None,
        hw_pct: float | None,
        reason: str,
        *,
        changed: bool,
        ceiling: int | None = None,
        floor: int | None = None,
    ) -> None:
        """Update the live status surfaced by the API/UI."""
        self._status[miner_id] = {
            "miner_id": miner_id,
            "frequency_mhz": freq,
            "ceiling_mhz": ceiling,
            "floor_mhz": floor,
            "vr_temp_c": round(vr_c, 1) if vr_c is not None else None,
            "hw_error_pct": round(hw_pct, 3) if hw_pct is not None else None,
            "reason": reason,
            "changed": bool(changed),
            "ts": int(time.time()),
        }


def _coerce_bool(value: Any) -> bool:
    """SQLite stores the per-miner flag as 0/1; tolerate bool/str too."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return False


# Global instance (used by main.py)
guardian = GuardianController()
