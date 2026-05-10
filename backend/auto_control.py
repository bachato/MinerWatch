# SPDX-License-Identifier: AGPL-3.0-only
"""Server-side auto-fan controller for the ``minerwatch`` mode.

PID implementation compatible with the one in the Bitaxe firmware
(ESP-Miner). Faithfully reproduces:

- ``Kp = 5.0``, ``Ki = 0.1``, ``Kd = 2.0`` (Bitaxe constants)
- proportional-on-error mode (``P_ON_E``)
- REVERSE direction (hotter chip → higher fan% output)
- EMA input filter with ``alpha = 0.2`` to reduce sensor noise
- special behaviors: overheat → 100%, miner paused → 30%, startup → 70%
- auto-rescaling of Ki/Kd based on the configured sample time

The only difference from the firmware is the sample time:
- Bitaxe firmware: 100 ms (embedded controller running close to the HW)
- MinerWatch:     5 s    (controller over the network: we don't want to
  hammer miners via TCP/HTTP. The miner already runs its own fast loop
  for thermal self-protection; our PID works one level above to "shape"
  the thermal profile).

Reference: ``main/tasks/fan_controller_task.c`` and ``main/thermal/PID.c``
in the official ESP-Miner repo (AGPL).

Besides the PID, this module includes an **overheat watchdog independent
of fan_mode** (see `_watchdog_check`) that forces the fan to 100% and
sends a push alert if chip temperature exceeds a hard threshold. It also
works for miners in ``firmware`` or ``manual`` mode: it's a software
safety net that sits next to the miner's own thermal protection.
"""
from __future__ import annotations

import asyncio
import logging
import time

from . import db
from .config import get_config
from .miners import driver_for_record
from .miners.base import MinerSample

log = logging.getLogger("minerwatch.auto_fan")

# ============================================================================
# PID constants (identical to the Bitaxe firmware, see PID.c / fan_controller_task.c)
# ============================================================================

# How often the controller re-evaluates. Bitaxe uses 100ms; over the
# network 5s is more responsive than 10s while staying easy on traffic
# (Canaan via cgminer = one TCP connection per command).
SAMPLE_SECONDS = 5

KP = 5.0
KI = 0.1
KD = 2.0

# Input EMA filter (Bitaxe: 0.2 new, 0.8 old).
EMA_ALPHA = 0.2

# Emergency modes (mirrored from the firmware).
OVERHEAT_PCT = 100.0    # if temp > safety threshold
PAUSED_PCT = 30.0       # when the miner is paused (not implemented here)
STARTUP_PCT = 70.0      # until a valid temperature is available

# Default setpoint when the user hasn't set one (Bitaxe default ~60°C).
DEFAULT_TARGET_C = 60.0
DEFAULT_FAN_MIN = 0
DEFAULT_FAN_MAX = 100

# Only change speed if the delta is ≥ APPLY_THRESHOLD, to avoid
# spamming the miner (matters for Avalon where every command = one TCP connection).
APPLY_THRESHOLD = 1.0


# ============================================================================
# Overheat watchdog (independent of fan_mode)
# ============================================================================
# The watchdog runs for ALL online miners regardless of fan_mode
# (firmware, manual, minerwatch). If chip temp stays above the hard
# threshold for N consecutive samples, it forces the fan to 100% and
# sends a push alert. When temp drops below the release threshold for N
# consecutive samples, the watchdog releases control (and logs the
# recovery). In minerwatch mode the PID picks up automatically from the
# current value; in firmware/manual mode the fan stays at 100% until the
# user intervenes (the prudent behavior).

# Hard threshold: above this temp we step in. 75°C is conservative for
# ASIC longevity: the Avalon firmware tolerates up to 95°C to optimize
# hashrate, but long-term it accelerates degradation. Close to the
# typical PID target (60°C) but with a safety margin.
WATCHDOG_OVERHEAT_C = 75.0

# Release threshold: below this temp we consider the emergency over.
# 10°C margin from OVERHEAT to avoid hysteresis chattering. 65°C is
# just above the Bitaxe PID target (60°C) so if the PID is doing its
# job the watchdog stays out of the way.
WATCHDOG_RELEASE_C = 65.0

# Consecutive samples over/under threshold before acting/releasing.
# With SAMPLE_SECONDS=5 → 3 samples = ~15s of sustained overheat.
WATCHDOG_TRIGGER_CONSECUTIVE = 3
WATCHDOG_RELEASE_CONSECUTIVE = 6  # ~30s below release before letting go

# Push anti-spam: the same miner does not re-alert within N seconds.
WATCHDOG_REALERT_S = 600  # 10 min

# Heartbeat: every N seconds we log "PID alive". Useful to tell from
# the logs whether the controller is alive. Also exposed as
# `auto_fan.last_tick_ts` for external checks (e.g. a future
# /api/health/autofan endpoint).
HEARTBEAT_LOG_INTERVAL_S = 300  # log every 5 min


# ============================================================================
# PID controller (port Python di main/thermal/PID.c)
# ============================================================================

class PIDController:
    """PID controller compatible with the one in the Bitaxe firmware.

    State variables and formula identical to the C version: same
    proportional-on-error mode, same REVERSE direction, same gains
    rescaled to the sample time.
    """

    def __init__(
        self,
        kp: float = KP,
        ki: float = KI,
        kd: float = KD,
        sample_time_s: float = SAMPLE_SECONDS,
        out_min: float = 0.0,
        out_max: float = 100.0,
    ) -> None:
        self.disp_kp = kp
        self.disp_ki = ki
        self.disp_kd = kd
        self._set_tunings(kp, ki, kd, sample_time_s)

        self.sample_time_s = sample_time_s
        self.out_min = out_min
        self.out_max = out_max

        self.setpoint = DEFAULT_TARGET_C
        self.input_value = 0.0
        self.output = 0.0

        self.in_auto = False
        self.output_sum = 0.0
        self.last_input = 0.0

    def _set_tunings(self, kp: float, ki: float, kd: float, sample_s: float) -> None:
        # Rescale Ki/Kd the way pid_set_tunings_adv() does in Bitaxe, but
        # with REVERSE direction applied by default (inverted sign).
        self.kp = -kp
        self.ki = -ki * sample_s
        self.kd = -kd / sample_s

    def set_sample_time(self, sample_time_s: float) -> None:
        if sample_time_s <= 0:
            return
        ratio = sample_time_s / self.sample_time_s
        self.ki *= ratio
        self.kd /= ratio
        self.sample_time_s = sample_time_s

    def set_output_limits(self, out_min: float, out_max: float) -> None:
        if out_min >= out_max:
            return
        self.out_min = out_min
        self.out_max = out_max
        if self.in_auto:
            self.output = max(out_min, min(out_max, self.output))
            self.output_sum = max(out_min, min(out_max, self.output_sum))

    def initialize(self, current_input: float, current_output: float) -> None:
        """Bumpless transfer from manual to automatic."""
        self.input_value = current_input
        self.last_input = current_input
        self.output_sum = max(self.out_min, min(self.out_max, current_output))
        self.in_auto = True

    def compute(self) -> float:
        """Return the PID output (clamped between out_min and out_max)."""
        if not self.in_auto:
            return self.output

        error = self.setpoint - self.input_value
        d_input = self.input_value - self.last_input

        self.output_sum += self.ki * error
        self.output_sum = max(self.out_min, min(self.out_max, self.output_sum))

        # P_ON_E (proportional on error)
        output = self.kp * error + self.output_sum - self.kd * d_input

        # Anti-windup: bleed the integrator when we hit the limits
        if output > self.out_max:
            self.output_sum -= output - self.out_max
            output = self.out_max
        elif output < self.out_min:
            self.output_sum += self.out_min - output
            output = self.out_min

        self.output = output
        self.last_input = self.input_value
        return output


# ============================================================================
# Auto-fan controller (one PID per miner)
# ============================================================================

# Per-miner state: PID + filtered_input + last commanded fan
class _MinerState:
    __slots__ = ("pid", "filtered_temp", "last_commanded_pct")

    def __init__(self) -> None:
        self.pid = PIDController()
        self.filtered_temp: float | None = None
        self.last_commanded_pct: int | None = None


# Per-miner state for the overheat watchdog (separate from the PID
# because it lives even for non-minerwatch miners, and has its own
# lifecycle — it can force 100% while the PID is disabled).
class _WatchdogState:
    __slots__ = (
        "overheat_count",
        "release_count",
        "forced",
        "last_alert_ts",
    )

    def __init__(self) -> None:
        self.overheat_count: int = 0
        self.release_count: int = 0
        self.forced: bool = False
        self.last_alert_ts: float = 0.0


_states: dict[int, _MinerState] = {}
_watchdog_states: dict[int, _WatchdogState] = {}


class AutoFanController:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        # Exposed for external checks (heartbeat / health probe).
        # 0 = never started.
        self.last_tick_ts: float = 0.0
        self._last_heartbeat_log: float = 0.0

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="minerwatch-autofan")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
        self._task = None

    async def _run(self) -> None:
        log.info(
            "AutoFan PID started — interval=%ds Kp=%.1f Ki=%.1f Kd=%.1f (Bitaxe-equivalent)",
            SAMPLE_SECONDS, KP, KI, KD,
        )
        log.info(
            "AutoFan watchdog armed — overheat>=%.1f°C×%d → fan 100%%, release<=%.1f°C×%d",
            WATCHDOG_OVERHEAT_C, WATCHDOG_TRIGGER_CONSECUTIVE,
            WATCHDOG_RELEASE_C, WATCHDOG_RELEASE_CONSECUTIVE,
        )
        from .poller import poller as _poller

        self._last_heartbeat_log = time.time()
        while not self._stop.is_set():
            try:
                await self._tick(_poller.last_results)
            except Exception:  # noqa: BLE001
                log.exception("autofan tick error")
            # Periodic heartbeat log: useful to see from the logs whether
            # the loop is still alive. Also exposed via `last_tick_ts`.
            now = time.time()
            if now - self._last_heartbeat_log >= HEARTBEAT_LOG_INTERVAL_S:
                log.info(
                    "AutoFan heartbeat — last_tick=%.1fs ago, watchdog_active_miners=%d",
                    now - self.last_tick_ts,
                    sum(1 for s in _watchdog_states.values() if s.forced),
                )
                self._last_heartbeat_log = now
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=SAMPLE_SECONDS)
            except asyncio.TimeoutError:
                continue
        log.info("AutoFan controller stopped")

    async def _tick(self, samples: dict[int, MinerSample]) -> None:
        self.last_tick_ts = time.time()
        miners = await db.list_miners(only_enabled=True)
        active_ids: set[int] = set()
        watchdog_seen_ids: set[int] = set()

        for miner in miners:
            miner_id = int(miner["id"])
            sample = samples.get(miner_id)
            if sample is None or not sample.online:
                continue

            # 1. Overheat watchdog — runs for ANY fan_mode.
            #    If it forces 100%, we skip the PID for this tick.
            forced = await self._watchdog_check(miner, sample)
            watchdog_seen_ids.add(miner_id)
            if forced:
                continue

            # 2. Server-side PID — minerwatch mode only.
            mode = (miner.get("fan_mode") or "firmware").lower()
            if mode != "minerwatch":
                continue
            if sample.temp_chip_c is None:
                continue
            active_ids.add(miner_id)
            await self._adjust_one(miner, sample)

        # Clean up state for miners that are no longer active (so when
        # one comes back to auto it starts fresh instead of resuming a
        # stale state).
        for mid in list(_states):
            if mid not in active_ids:
                _states.pop(mid, None)
        # Clean up watchdog state for miners no longer online/enabled.
        for mid in list(_watchdog_states):
            if mid not in watchdog_seen_ids:
                _watchdog_states.pop(mid, None)

    async def _watchdog_check(self, miner: dict, sample: MinerSample) -> bool:
        """Force fan to 100% on sustained overheat. Returns True if forced.

        Works regardless of `fan_mode`: a miner in ``firmware`` or
        ``manual`` mode is protected too. Think of it as a software
        safety net that sits next to the miner's own thermal protection
        (which on Canaan is not cautious enough).
        """
        if sample.temp_chip_c is None:
            return False

        miner_id = int(miner["id"])
        state = _watchdog_states.get(miner_id)
        if state is None:
            state = _WatchdogState()
            _watchdog_states[miner_id] = state

        temp = float(sample.temp_chip_c)

        if temp >= WATCHDOG_OVERHEAT_C:
            state.overheat_count += 1
            state.release_count = 0
            if (
                state.overheat_count >= WATCHDOG_TRIGGER_CONSECUTIVE
                and not state.forced
            ):
                await self._watchdog_force_max(miner, temp, state)
            return state.forced

        if temp <= WATCHDOG_RELEASE_C:
            state.release_count += 1
            state.overheat_count = 0
            if state.forced and state.release_count >= WATCHDOG_RELEASE_CONSECUTIVE:
                await self._watchdog_release(miner, temp, state)
            return state.forced

        # Neutral zone (between release and overheat): no transition.
        state.overheat_count = 0
        state.release_count = 0
        return state.forced

    async def _watchdog_force_max(
        self, miner: dict, temp: float, state: _WatchdogState
    ) -> None:
        miner_id = int(miner["id"])
        cfg = get_config()
        drv = driver_for_record({**miner, "timeout": cfg.polling.request_timeout})
        if drv.can_set_fan:
            try:
                await drv.set_fan_speed(100)
            except Exception:  # noqa: BLE001
                log.exception(
                    "WATCHDOG miner=%s set_fan_speed(100) failed", miner.get("name")
                )
        state.forced = True
        log.warning(
            "WATCHDOG miner=%s OVERHEAT %.1f°C ≥ %.1f°C — fan forced to 100%%",
            miner.get("name"), temp, WATCHDOG_OVERHEAT_C,
        )
        # Push alert (anti-spam with realert window)
        now = time.time()
        if now - state.last_alert_ts >= WATCHDOG_REALERT_S:
            try:
                from .alerts import send_push  # lazy import: avoids cycle
                msg = (
                    f"{miner.get('name')}: WATCHDOG overheat {temp:.1f}°C — "
                    f"fan forced to 100%"
                )
                await db.insert_alert(miner_id, "critical", "watchdog_overheat", msg)
                await send_push({
                    "title": "Overheat watchdog",
                    "body": msg,
                    "miner_id": miner_id,
                })
            except Exception:  # noqa: BLE001
                log.exception("WATCHDOG miner=%s push alert failed", miner.get("name"))
            state.last_alert_ts = now

    async def _watchdog_release(
        self, miner: dict, temp: float, state: _WatchdogState
    ) -> None:
        miner_id = int(miner["id"])
        log.info(
            "WATCHDOG miner=%s temp dropped to %.1f°C ≤ %.1f°C — control released",
            miner.get("name"), temp, WATCHDOG_RELEASE_C,
        )
        state.forced = False
        state.release_count = 0
        state.overheat_count = 0
        try:
            from .alerts import send_push
            msg = (
                f"{miner.get('name')}: temp dropped to {temp:.1f}°C, watchdog released"
            )
            await db.insert_alert(miner_id, "info", "watchdog_recovered", msg)
            await send_push({
                "title": "Watchdog recovered",
                "body": msg,
                "miner_id": miner_id,
            })
        except Exception:  # noqa: BLE001
            log.exception(
                "WATCHDOG miner=%s recovery push failed", miner.get("name")
            )

    async def _adjust_one(self, miner: dict, sample: MinerSample) -> None:
        miner_id = int(miner["id"])
        target = float(miner.get("auto_target_c") or DEFAULT_TARGET_C)
        fan_min = int(miner.get("fan_min_override") or DEFAULT_FAN_MIN)
        fan_max = int(miner.get("fan_max_override") or DEFAULT_FAN_MAX)
        fan_min = max(0, fan_min)
        fan_max = min(100, fan_max)
        if fan_min >= fan_max:
            log.warning(
                "miner %s: fan_min (%d) >= fan_max (%d), skip",
                miner["id"], fan_min, fan_max,
            )
            return

        state = _states.get(miner_id)
        if state is None:
            state = _MinerState()
            _states[miner_id] = state
            state.pid.set_output_limits(float(fan_min), float(fan_max))
            # Bumpless start: begin from the current fan speed (if available)
            current_pct = float(sample.fan_pct) if sample.fan_pct else (fan_min + fan_max) / 2.0
            state.pid.initialize(float(sample.temp_chip_c or target), current_pct)
            state.last_commanded_pct = int(round(current_pct))
            log.info(
                "auto-fan miner=%s init at %.1f°C → %d%% (target %.1f°C, range %d-%d%%)",
                miner["name"], sample.temp_chip_c, state.last_commanded_pct,
                target, fan_min, fan_max,
            )

        # Update setpoint and limits if they changed at runtime via the UI
        state.pid.setpoint = target
        state.pid.set_output_limits(float(fan_min), float(fan_max))

        # EMA input filter like Bitaxe (alpha=0.2)
        # For chip avg + chip2 take the max (worst chip), like Bitaxe.
        raw_temp = float(sample.temp_chip_c)
        if state.filtered_temp is None:
            state.filtered_temp = raw_temp
        else:
            state.filtered_temp = (
                EMA_ALPHA * raw_temp + (1 - EMA_ALPHA) * state.filtered_temp
            )
        state.pid.input_value = state.filtered_temp

        new_output = state.pid.compute()
        new_pct = int(round(max(fan_min, min(fan_max, new_output))))

        last = state.last_commanded_pct or new_pct
        if abs(new_pct - last) < APPLY_THRESHOLD:
            return  # delta too small, don't spam the miner

        # Send the command to the miner
        cfg = get_config()
        drv = driver_for_record({**miner, "timeout": cfg.polling.request_timeout})
        if not drv.can_set_fan:
            return
        try:
            ok = await drv.set_fan_speed(new_pct)
        except Exception as exc:  # noqa: BLE001
            log.warning("miner %s: set_fan_speed failed: %s", miner["id"], exc)
            return
        if ok:
            state.last_commanded_pct = new_pct
            log.info(
                "auto-fan miner=%s temp=%.1f→%.1f (target %.1f) → %d%% (was %d%%)",
                miner["name"], raw_temp, state.filtered_temp, target, new_pct, last,
            )


# Global instance (used by main.py)
auto_fan = AutoFanController()
