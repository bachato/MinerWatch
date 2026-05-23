# SPDX-License-Identifier: AGPL-3.0-only
"""Efficiency/performance tuner for AxeOS miners (Bitaxe / Nerd*).

Given a target temperature (a *profile*: Performance or Eco), this finds
the frequency/coreVoltage pair that gives the best sustainable hashrate
while the chip is held near the target. It does NOT regulate the fan
itself: it puts the miner into the existing ``minerwatch`` fan mode with
the profile's target and fan cap, and lets the server-side auto-fan PID
(``auto_control.py``) do the cooling. The tuner then sweeps freq/voltage
and reads the resulting hashrate / temp / power / fan duty.

This module is a self-contained *bolt-on*: it only calls driver methods
that already exist (``set_frequency`` / ``set_voltage`` / ``restart`` /
``poll``) and persists into its own ``tuner_sessions`` / ``tuner_points``
tables. Nothing else in the codebase depends on it, so the whole feature
can be removed by deleting this file, its two DB tables, the API
endpoints and the UI tab. See ``docs/tuner-design.md``.

Safety model:
  - Hard cutoffs (chip, VR, power, input voltage) abort a single test
    point; they sit *below* the global 75 °C auto-fan watchdog, which
    stays armed as a last-resort net.
  - The pre-session miner state (freq, voltage, fan config) is snapshotted
    and restored on cancel/error/no-result. On success the winning pair is
    applied and the profile's fan policy is kept.
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

log = logging.getLogger("minerwatch.tuner")

# Families this tuner knows how to drive. Both speak the AxeOS REST API.
SUPPORTED_FAMILIES = ("bitaxe", "nerdoctaxe")


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _trimmed_mean(values: list[float], trim: int) -> float | None:
    """Mean after dropping the ``trim`` lowest and ``trim`` highest values.

    Falls back to a plain mean when there aren't enough samples to trim.
    Returns None for an empty list.
    """
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    if len(vals) > 2 * trim + 1:
        vals = vals[trim : len(vals) - trim]
    return sum(vals) / len(vals)


class TunerController:
    """Owns the lifecycle of tuning sessions (at most one per miner)."""

    def __init__(self) -> None:
        # miner_id -> running asyncio.Task
        self._tasks: dict[int, asyncio.Task] = {}
        # miner_id -> cancellation flag
        self._cancel: dict[int, asyncio.Event] = {}
        # miner_id -> live progress dict (for the status endpoint)
        self._progress: dict[int, dict[str, Any]] = {}

    # ---------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------

    def is_running(self, miner_id: int) -> bool:
        task = self._tasks.get(int(miner_id))
        return bool(task and not task.done())

    def progress(self, miner_id: int) -> dict[str, Any] | None:
        return self._progress.get(int(miner_id))

    async def start_session(
        self,
        miner: dict[str, Any],
        profile_key: str,
        start_frequency: int | None = None,
    ) -> int:
        """Validate, snapshot baseline, create the DB session, launch the run.

        ``start_frequency`` is an optional advanced override for where the
        sweep begins; when None the per-profile default (current ± offset) is
        used. Returns the new session id. Raises ValueError on bad input and
        RuntimeError if a session is already running for this miner.
        """
        cfg = get_config()
        if not cfg.tuner.enabled:
            raise ValueError("tuner is disabled")

        profile_key = (profile_key or "").lower()
        profile = cfg.tuner.profiles.get(profile_key)
        if not profile:
            raise ValueError(f"unknown profile: {profile_key!r}")

        family = (miner.get("family") or "").lower()
        if family not in SUPPORTED_FAMILIES:
            raise ValueError(f"tuning is only supported on Bitaxe/Nerd* (got {family!r})")

        miner_id = int(miner["id"])
        if self.is_running(miner_id):
            raise RuntimeError("a tuning session is already running for this miner")
        # Also guard against a stale DB 'running' row from a previous crash.
        existing = await db.get_active_tuner_session(miner_id)
        if existing:
            raise RuntimeError("a tuning session is already running for this miner")

        drv = driver_for_record({**miner, "timeout": cfg.polling.request_timeout})
        if not (drv.can_set_frequency and drv.can_set_voltage and drv.can_restart):
            raise ValueError("this miner does not expose freq/voltage/restart control")

        # Snapshot the pre-session state we need to restore on abort. The
        # freq/voltage come from a fresh poll (best effort); the fan config
        # comes straight from the DB record.
        orig: dict[str, Any] = {
            "fan_mode": miner.get("fan_mode"),
            "auto_target_c": miner.get("auto_target_c"),
            "fan_min": miner.get("fan_min_override"),
            "fan_max": miner.get("fan_max_override"),
        }
        try:
            base = await drv.poll()
            if base.online:
                orig["frequency_mhz"] = base.frequency_mhz
                orig["voltage_mv"] = base.voltage_mv
        except Exception:  # noqa: BLE001
            pass

        session_id = await db.create_tuner_session(
            miner_id=miner_id,
            profile=profile_key,
            target_c=float(profile["target_c"]),
            fan_cap_pct=int(profile["fan_cap_pct"]),
            orig=orig,
        )

        self._cancel[miner_id] = asyncio.Event()
        self._progress[miner_id] = {
            "session_id": session_id,
            "phase": "starting",
            "profile": profile_key,
            "points_done": 0,
            "current": None,
            "message": None,
        }
        self._tasks[miner_id] = asyncio.create_task(
            self._run_session(miner, profile_key, profile, session_id, start_frequency),
            name=f"minerwatch-tuner-{miner_id}",
        )
        log.info(
            "tuner: started session %s on miner=%s profile=%s",
            session_id, miner.get("name"), profile_key,
        )
        return session_id

    async def cancel_session(self, miner_id: int) -> bool:
        miner_id = int(miner_id)
        ev = self._cancel.get(miner_id)
        if ev is None or not self.is_running(miner_id):
            return False
        ev.set()
        log.info("tuner: cancellation requested for miner=%s", miner_id)
        return True

    async def shutdown(self) -> None:
        """Cancel every running session (called on app shutdown)."""
        for ev in self._cancel.values():
            ev.set()
        tasks = [t for t in self._tasks.values() if not t.done()]
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await asyncio.wait_for(asyncio.shield(t), timeout=2)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    # ---------------------------------------------------------------
    # Internal: the session runner
    # ---------------------------------------------------------------

    async def _run_session(
        self,
        miner: dict[str, Any],
        profile_key: str,
        profile: dict[str, Any],
        session_id: int,
        start_frequency: int | None = None,
    ) -> None:
        miner_id = int(miner["id"])
        cfg = get_config()
        tcfg = cfg.tuner
        drv = driver_for_record({**miner, "timeout": cfg.polling.request_timeout})
        cancel = self._cancel[miner_id]
        target_c = float(profile["target_c"])
        fan_cap = int(profile["fan_cap_pct"])

        valid_points: list[dict[str, Any]] = []
        status = "completed"
        message = ""

        try:
            # --- Baseline: poll until online, derive expected hashrate ----
            self._set_phase(miner_id, session_id, "baseline")
            base = await self._poll_until_online(drv, cancel, timeout_s=120)
            if base is None:
                raise RuntimeError("miner did not come online for baseline")

            ths_per_mhz: float | None = None
            if base.hashrate_ths and base.frequency_mhz:
                ths_per_mhz = float(base.hashrate_ths) / float(base.frequency_mhz)

            # --- Hand the fan to the existing minerwatch PID at target ----
            # fan_max_override enforces the profile's noise/cooling cap.
            await db.set_fan_config(
                miner_id,
                fan_mode="minerwatch",
                auto_target_c=target_c,
                fan_max_override=fan_cap,
            )

            # --- Current (stock) settings = the starting anchor ----------
            current_freq = (
                int(base.frequency_mhz) if base.frequency_mhz
                else int(tcfg.frequency_floor_mhz)
            )
            current_volt = (
                int(base.voltage_mv) if base.voltage_mv
                else int(tcfg.voltage_floor_mv)
            )

            # --- Search space --------------------------------------------
            dev_lo, dev_hi = await self._resolve_freq_range(drv, tcfg)
            volt_lo = int(tcfg.voltage_floor_mv)
            volt_hi = int(tcfg.voltage_ceiling_mv)
            f_off = int(profile.get("start_freq_offset_mhz", 0))
            v_off = int(profile.get("start_volt_offset_mv", 0))
            # Start frequency: user override if given, else current + profile
            # offset, clamped to the device-valid range. The ceiling stays the
            # config/device guardrail and is NOT user-settable.
            if start_frequency:
                start_freq = int(_clamp(int(start_frequency), dev_lo, dev_hi))
            else:
                start_freq = int(_clamp(current_freq + f_off, dev_lo, dev_hi))
            freq_hi = dev_hi
            # First Vmin-search voltage: current + profile offset, clamped.
            # Deliberately on the low side so the upward search finds the
            # true minimum instead of validating immediately at too-high mV.
            v_start = int(_clamp(current_volt + v_off, volt_lo, volt_hi))

            settle_max = (
                tcfg.settle_max_s_nerdoctaxe
                if (miner.get("family") or "").lower() == "nerdoctaxe"
                else tcfg.settle_max_s_bitaxe
            )
            power_ceiling = (
                tcfg.power_ceiling_nerdoctaxe_w
                if (miner.get("family") or "").lower() == "nerdoctaxe"
                else tcfg.power_ceiling_bitaxe_w
            )

            log.info(
                "tuner: session %s sweep from %s MHz (start_volt %s mV) up to %s MHz",
                session_id, start_freq, v_start, freq_hi,
            )

            freqs = list(range(start_freq, freq_hi + 1, int(tcfg.frequency_step_mhz)))
            total_steps = max(1, min(len(freqs), int(tcfg.max_points)))

            freq_done = 0
            for freq_index, freq in enumerate(freqs):
                if cancel.is_set():
                    status, message = "cancelled", "cancelled by user"
                    break
                if freq_done >= int(tcfg.max_points):
                    message = "reached the max number of test points"
                    break

                self._set_phase(
                    miner_id, session_id, "sweeping",
                    current={"frequency_mhz": freq, "voltage_mv": v_start},
                    progress=freq_done / total_steps,
                )

                # _find_vmin_point measures + persists each probed point and
                # returns the full-window keeper for the winner selection.
                outcome, point = await self._find_vmin_point(
                    drv, cancel, freq, v_start, volt_hi,
                    tcfg, target_c, fan_cap, settle_max, power_ceiling,
                    ths_per_mhz, miner_id, session_id, freq_index, total_steps,
                )
                if outcome == "cancelled":
                    status, message = "cancelled", "cancelled by user"
                    break

                freq_done += 1

                if outcome == "valid" and point is not None:
                    valid_points.append(point)
                    v_start = int(point["voltage_mv"])  # warm-start next freq
                    # Fan saturated at this freq → we're at the thermal
                    # ceiling; higher frequencies won't be coolable.
                    if point.get("fan_saturated"):
                        message = "thermal ceiling reached (fan saturated)"
                        break
                elif outcome == "unsafe":
                    message = "thermal/power limit reached"
                    break
                elif outcome == "unstable":
                    # Could not stabilise even at max voltage for this freq;
                    # higher frequencies are even less likely to stabilise.
                    message = "could not stabilise at the top of the voltage range"
                    break

            # --- Pick the winner and apply it ----------------------------
            if cancel.is_set():
                status, message = "cancelled", message or "cancelled by user"

            if status == "cancelled":
                await self._restore_baseline(drv, session_id)
            elif valid_points:
                self._set_phase(miner_id, session_id, "applying")
                best = self._pick_winner(valid_points, profile)
                await self._apply_point(drv, best)
                await db.update_tuner_session(
                    session_id,
                    best_frequency_mhz=best["frequency_mhz"],
                    best_voltage_mv=best["voltage_mv"],
                    best_score=best.get("score"),
                    message=message or "completed",
                )
            else:
                message = message or "no stable, safe point was found"
                await self._restore_baseline(drv, session_id)

        except asyncio.CancelledError:
            status, message = "cancelled", "cancelled (server shutdown)"
            try:
                await self._restore_baseline(drv, session_id)
            except Exception:  # noqa: BLE001
                pass
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("tuner: session %s failed", session_id)
            status, message = "error", str(exc)
            try:
                await self._restore_baseline(drv, session_id)
            except Exception:  # noqa: BLE001
                pass
        finally:
            await db.update_tuner_session(
                session_id,
                status=status,
                finished_at=db.now_ts(),
                progress=1.0,
                message=message or status,
            )
            prog = self._progress.get(miner_id)
            if prog is not None:
                prog["phase"] = status
                prog["message"] = message
            self._cancel.pop(miner_id, None)
            self._tasks.pop(miner_id, None)
            log.info("tuner: session %s ended status=%s (%s)", session_id, status, message)

    # ---------------------------------------------------------------
    # Internal: per-frequency Vmin search + point measurement
    # ---------------------------------------------------------------

    async def _find_vmin_point(
        self,
        drv,
        cancel: asyncio.Event,
        freq: int,
        v_start: int,
        v_hi: int,
        tcfg,
        target_c: float,
        fan_cap: int,
        settle_max: int,
        power_ceiling: float,
        ths_per_mhz: float | None,
        miner_id: int,
        session_id: int,
        freq_index: int,
        total_steps: int,
    ) -> tuple[str, dict[str, Any] | None]:
        """Find the minimum stable+safe voltage at ``freq``.

        Each voltage step is first measured with a SHORT probe (instability
        shows up in the error rate within seconds); only the chosen voltage
        gets a full-window measurement for accurate hashrate/efficiency. Every
        measured point is persisted so the live window fills in as we go.

        Returns ``(outcome, point)`` where outcome is one of
        ``valid`` / ``unstable`` / ``unsafe`` / ``cancelled``. ``point`` is
        the full-window keeper for a valid result, else the last-tried point.
        """
        step = int(tcfg.voltage_step_mv)
        last_point: dict[str, Any] | None = None
        volt = int(_clamp(v_start, tcfg.voltage_floor_mv, v_hi))
        probes = 0
        max_probes = 40  # finer 10 mV steps → allow a wide voltage ladder

        while volt <= v_hi and probes < max_probes:
            if cancel.is_set():
                return "cancelled", last_point
            probes += 1
            self._bump_probe(miner_id, session_id, freq, volt, freq_index, total_steps)

            quick = await self._measure_point(
                drv, cancel, freq, volt, tcfg, target_c, fan_cap,
                settle_max, power_ceiling, ths_per_mhz, quick=True,
            )
            if quick is None:  # cancelled mid-measure
                return "cancelled", last_point
            last_point = quick

            if quick["outcome"] == "unsafe":
                await self._save_point(session_id, quick)
                return "unsafe", quick

            if quick["outcome"] == "valid":
                # Confirm the candidate with a full-window measurement.
                full = await self._measure_point(
                    drv, cancel, freq, volt, tcfg, target_c, fan_cap,
                    settle_max, power_ceiling, ths_per_mhz, quick=False,
                )
                if full is None:
                    return "cancelled", last_point
                await self._save_point(session_id, full)
                last_point = full
                if full["outcome"] == "valid":
                    return "valid", full
                if full["outcome"] == "unsafe":
                    return "unsafe", full
                # Full window disagrees with the quick probe → keep climbing.
                volt += step
                continue

            # unstable on the quick probe → record the attempt and step up.
            await self._save_point(session_id, quick)
            volt += step

        # Ran out of voltage headroom without stabilising.
        return "unstable", last_point

    async def _save_point(self, session_id: int, point: dict[str, Any]) -> None:
        """Persist a measured point (best-effort; never fatal to the run)."""
        try:
            await db.insert_tuner_point(session_id, {**point, "ts": db.now_ts()})
        except Exception:  # noqa: BLE001
            log.warning("tuner: failed to persist point for session %s", session_id)

    def _bump_probe(
        self, miner_id: int, session_id: int, freq: int, volt: int,
        freq_index: int, total_steps: int,
    ) -> None:
        """Advance the live status on every voltage probe (so the window
        visibly moves during a per-frequency voltage ladder, not only when
        the frequency changes)."""
        prog = self._progress.get(miner_id)
        if prog is None:
            prog = {"session_id": session_id}
            self._progress[miner_id] = prog
        prog["phase"] = "sweeping"
        prog["current"] = {"frequency_mhz": freq, "voltage_mv": volt}
        prog["points_done"] = prog.get("points_done", 0) + 1
        base = freq_index / max(1, total_steps)
        prog["progress"] = round(min(0.98, base + 0.02), 3)

    async def _measure_point(
        self,
        drv,
        cancel: asyncio.Event,
        freq: int,
        volt: int,
        tcfg,
        target_c: float,
        fan_cap: int,
        settle_max: int,
        power_ceiling: float,
        ths_per_mhz: float | None,
        quick: bool = False,
    ) -> dict[str, Any] | None:
        """Set (freq, volt), let it settle, sample, classify. None if cancelled.

        ``quick`` uses a short window (for the Vmin voltage ladder, where the
        error rate reveals instability fast); the full window is used only for
        the chosen keeper, for accurate hashrate/temperature/efficiency.
        """
        if quick:
            window_s = int(tcfg.probe_window_s)
            settle_cap = min(int(settle_max), int(tcfg.probe_settle_max_s))
            warmup = int(tcfg.probe_warmup_samples)
            min_samp = int(tcfg.probe_min_samples)
            trim = 0
        else:
            window_s = int(tcfg.sample_window_s)
            settle_cap = int(settle_max)
            warmup = int(tcfg.warmup_samples)
            min_samp = int(tcfg.min_samples)
            trim = int(tcfg.outlier_trim)

        await drv.set_frequency(int(freq))
        await drv.set_voltage(int(volt))
        await drv.restart()

        # Wait out the reboot, then for the miner to answer again.
        if await self._sleep_or_cancel(cancel, tcfg.post_restart_wait_s):
            return None
        online = await self._poll_until_online(drv, cancel, timeout_s=120)
        if online is None:
            if cancel.is_set():
                return None
            # Treat a no-show as unsafe (don't keep pushing this point).
            return self._point(freq, volt, None, "unsafe", ths_per_mhz)

        # Settle: wait until chip temperature flattens (or settle_max).
        prev_t: float | None = None
        flat = 0
        waited = 0
        while waited < settle_cap:
            if cancel.is_set():
                return None
            s = await self._safe_poll(drv)
            t = s.temp_chip_c if s else None
            if t is not None and prev_t is not None and abs(t - prev_t) < 0.5:
                flat += 1
                if flat >= 2:
                    break
            else:
                flat = 0
            prev_t = t
            waited += tcfg.sample_interval_s
            if await self._sleep_or_cancel(cancel, tcfg.sample_interval_s):
                return None

        # Sampling window.
        hashes: list[float] = []
        temps: list[float] = []
        vrs: list[float] = []
        powers: list[float] = []
        fans: list[float] = []
        hw_start: int | None = None
        hw_end: int | None = None
        hw_t0: float | None = None
        hw_t1: float | None = None
        tot_start: int | None = None
        tot_end: int | None = None
        samples = 0
        window_steps = max(
            min_samp, int(window_s // max(1, tcfg.sample_interval_s))
        )
        for i in range(window_steps):
            if cancel.is_set():
                return None
            s = await self._safe_poll(drv)
            if s and s.online:
                # Live safety: bail out of this point the moment a hard
                # limit is crossed (don't wait for the average).
                breach = self._safety_breach(s, tcfg, power_ceiling)
                if breach:
                    log.info(
                        "tuner: point f=%s v=%s aborted (%s)", freq, volt, breach
                    )
                    return self._point(freq, volt, s, "unsafe", ths_per_mhz)
                if i >= warmup:
                    if s.hashrate_ths is not None:
                        hashes.append(float(s.hashrate_ths))
                    if s.temp_chip_c is not None:
                        temps.append(float(s.temp_chip_c))
                    if s.temp_vr_c is not None:
                        vrs.append(float(s.temp_vr_c))
                    if s.power_w is not None:
                        powers.append(float(s.power_w))
                    if s.fan_pct is not None:
                        fans.append(float(s.fan_pct))
                if s.hw_errors is not None:
                    now_m = time.monotonic()
                    if hw_start is None:
                        hw_start = int(s.hw_errors)
                        hw_t0 = now_m
                    hw_end = int(s.hw_errors)
                    hw_t1 = now_m
                if s.hw_total is not None:
                    if tot_start is None:
                        tot_start = int(s.hw_total)
                    tot_end = int(s.hw_total)
                samples += 1
            if await self._sleep_or_cancel(cancel, tcfg.sample_interval_s):
                return None

        avg_h = _trimmed_mean(hashes, trim)
        avg_t = sum(temps) / len(temps) if temps else None
        max_vr = max(vrs) if vrs else None
        avg_p = sum(powers) / len(powers) if powers else None
        avg_fan = sum(fans) / len(fans) if fans else None
        hw_delta = (hw_end - hw_start) if (hw_start is not None and hw_end is not None) else None
        hw_minutes = (
            (hw_t1 - hw_t0) / 60.0
            if (hw_t0 is not None and hw_t1 is not None and hw_t1 > hw_t0)
            else None
        )
        hw_rate = (
            hw_delta / hw_minutes
            if (hw_delta is not None and hw_minutes and hw_minutes > 0)
            else None
        )
        tot_delta = (
            (tot_end - tot_start)
            if (tot_start is not None and tot_end is not None)
            else None
        )
        # Real HW% only when the work denominator delta is positive — guards
        # against `total` not being a monotonic counter on some firmware.
        hw_pct = (
            (hw_delta / tot_delta) * 100.0
            if (hw_delta is not None and tot_delta and tot_delta > 0)
            else None
        )

        if len(hashes) < 1 or avg_h is None:
            return self._point(freq, volt, None, "unstable", ths_per_mhz,
                               temp=avg_t, vr=max_vr, power=avg_p, fan=avg_fan,
                               hw_delta=hw_delta)

        expected = (ths_per_mhz * freq) if ths_per_mhz else None
        # v2 stability gate, in order of preference:
        #   1. real HW error % (errorCount / total work over the window),
        #   2. error RATE in errors/min (firmware exposes an error counter but
        #      no usable work denominator, e.g. Nerd* duplicateHWNonces),
        #   3. hashrate vs expected (no error counter at all).
        # In all cases a point that's barely hashing is rejected as a sanity
        # check, so a "low error" reading on a stuck chip can't pass.
        if hw_pct is not None:
            stable = hw_pct <= tcfg.hw_error_pct_max
            if expected and avg_h < 0.5 * expected:
                stable = False
        elif hw_rate is not None:
            stable = hw_rate <= tcfg.hw_error_rate_max_per_min
            if expected and avg_h < 0.5 * expected:
                stable = False
        elif expected:
            stable = avg_h >= tcfg.stability_fraction * expected
        else:
            stable = avg_h > 0
        outcome = "valid" if stable else "unstable"

        eff = round(avg_p / avg_h, 2) if (avg_p and avg_h > 0) else None
        fan_saturated = bool(
            avg_fan is not None and avg_fan >= fan_cap - 3
            and avg_t is not None and avg_t > target_c + 2
        )

        return {
            "frequency_mhz": float(freq),
            "voltage_mv": float(volt),
            "hashrate_ths": round(avg_h, 4),
            "hashrate_expected_ths": round(expected, 4) if expected else None,
            "temp_chip_c": round(avg_t, 1) if avg_t is not None else None,
            "temp_vr_c": round(max_vr, 1) if max_vr is not None else None,
            "power_w": round(avg_p, 2) if avg_p is not None else None,
            "efficiency_j_th": eff,
            "fan_pct": round(avg_fan, 1) if avg_fan is not None else None,
            "hw_errors_delta": hw_delta,
            "hw_error_pct": round(hw_pct, 3) if hw_pct is not None else None,
            "outcome": outcome,
            "fan_saturated": fan_saturated,
        }

    # ---------------------------------------------------------------
    # Internal: helpers
    # ---------------------------------------------------------------

    def _point(
        self, freq: int, volt: int, s: MinerSample | None, outcome: str,
        ths_per_mhz: float | None, temp=None, vr=None, power=None, fan=None,
        hw_delta=None,
    ) -> dict[str, Any]:
        """Build a minimal point record for the non-valid outcomes."""
        t = temp if temp is not None else (s.temp_chip_c if s else None)
        v = vr if vr is not None else (s.temp_vr_c if s else None)
        p = power if power is not None else (s.power_w if s else None)
        f = fan if fan is not None else (s.fan_pct if s else None)
        h = s.hashrate_ths if s else None
        expected = (ths_per_mhz * freq) if ths_per_mhz else None
        eff = round(p / h, 2) if (p and h and h > 0) else None
        return {
            "frequency_mhz": float(freq),
            "voltage_mv": float(volt),
            "hashrate_ths": round(float(h), 4) if h else None,
            "hashrate_expected_ths": round(expected, 4) if expected else None,
            "temp_chip_c": round(float(t), 1) if t is not None else None,
            "temp_vr_c": round(float(v), 1) if v is not None else None,
            "power_w": round(float(p), 2) if p is not None else None,
            "efficiency_j_th": eff,
            "fan_pct": round(float(f), 1) if f is not None else None,
            "hw_errors_delta": hw_delta,
            "outcome": outcome,
            "fan_saturated": False,
        }

    def _safety_breach(self, s: MinerSample, tcfg, power_ceiling: float) -> str | None:
        """Return a reason string if any hard limit is crossed, else None."""
        if s.temp_chip_c is not None and s.temp_chip_c > tcfg.cutoff_chip_c:
            return f"chip {s.temp_chip_c:.1f}°C > {tcfg.cutoff_chip_c}°C"
        if s.temp_vr_c is not None and s.temp_vr_c > tcfg.cutoff_vr_c:
            return f"VR {s.temp_vr_c:.1f}°C > {tcfg.cutoff_vr_c}°C"
        if s.power_w is not None and s.power_w > power_ceiling:
            return f"power {s.power_w:.1f}W > {power_ceiling}W"
        # Input voltage (5V rail) lives in the raw payload as "voltage" (mV).
        try:
            in_mv = float((s.raw or {}).get("voltage")) if s.raw else None
        except (TypeError, ValueError):
            in_mv = None
        if in_mv is not None and in_mv > 0:
            if in_mv < tcfg.input_voltage_min_mv or in_mv > tcfg.input_voltage_max_mv:
                return f"input {in_mv:.0f}mV out of [{tcfg.input_voltage_min_mv},{tcfg.input_voltage_max_mv}]"
        return None

    def _pick_winner(
        self, points: list[dict[str, Any]], profile: dict[str, Any]
    ) -> dict[str, Any]:
        """Score valid points and return the best for the profile.

        Score (all terms normalised 0..1 across the valid set):
            score =  h_norm
                   + m_eff * e_norm
                   - w_fan * fan_norm
                   - k_temp * over_norm
        where h_norm rewards hashrate, e_norm rewards efficiency (lower
        J/TH is better), fan_norm penalises noise, over_norm penalises
        exceeding the target temperature.
        """
        target_c = float(profile["target_c"])
        k_temp = float(profile.get("k_temp", 0.0))
        w_fan = float(profile.get("w_fan", 0.0))
        m_eff = float(profile.get("m_eff", 0.0))

        if len(points) == 1:
            points[0]["score"] = 1.0
            return points[0]

        hs = [p["hashrate_ths"] for p in points if p.get("hashrate_ths") is not None]
        es = [p["efficiency_j_th"] for p in points if p.get("efficiency_j_th") is not None]
        h_min, h_max = (min(hs), max(hs)) if hs else (0.0, 1.0)
        e_min, e_max = (min(es), max(es)) if es else (0.0, 1.0)

        def norm(v, lo, hi):
            if v is None or hi <= lo:
                return 0.0
            return (v - lo) / (hi - lo)

        best = None
        best_score = float("-inf")
        for p in points:
            h_norm = norm(p.get("hashrate_ths"), h_min, h_max)
            # lower J/TH is better → invert
            e_norm = 1.0 - norm(p.get("efficiency_j_th"), e_min, e_max) if es else 0.0
            fan_norm = (p.get("fan_pct") or 0.0) / 100.0
            over = max(0.0, (p.get("temp_chip_c") or 0.0) - target_c)
            over_norm = min(1.0, over / 10.0)
            score = h_norm + m_eff * e_norm - w_fan * fan_norm - k_temp * over_norm
            p["score"] = round(score, 4)
            if score > best_score:
                best_score = score
                best = p
        return best or points[0]

    async def _apply_point(self, drv, point: dict[str, Any]) -> None:
        await drv.set_frequency(int(point["frequency_mhz"]))
        await drv.set_voltage(int(point["voltage_mv"]))
        await drv.restart()

    async def _restore_baseline(self, drv, session_id: int) -> None:
        """Put the miner back the way we found it (freq, voltage, fan)."""
        sess = await db.get_tuner_session(session_id)
        if not sess:
            return
        try:
            if sess.get("orig_frequency_mhz"):
                await drv.set_frequency(int(sess["orig_frequency_mhz"]))
            if sess.get("orig_voltage_mv"):
                await drv.set_voltage(int(sess["orig_voltage_mv"]))
            await drv.restart()
        except Exception:  # noqa: BLE001
            log.warning("tuner: failed to restore freq/voltage for session %s", session_id)
        # Restore fan config. COALESCE in set_fan_config means we can't reset
        # a column back to NULL, but restoring fan_mode is what matters: if it
        # goes back to non-minerwatch, the leftover target/cap are inert.
        try:
            await db.set_fan_config(
                int(sess["miner_id"]),
                fan_mode=sess.get("orig_fan_mode") or "firmware",
                auto_target_c=sess.get("orig_auto_target_c"),
                fan_min_override=sess.get("orig_fan_min"),
                fan_max_override=sess.get("orig_fan_max"),
            )
        except Exception:  # noqa: BLE001
            log.warning("tuner: failed to restore fan config for session %s", session_id)

    async def _resolve_freq_range(self, drv, tcfg) -> tuple[int, int]:
        """Frequency [lo, hi] to sweep — config range, narrowed by device if possible."""
        lo = int(tcfg.frequency_floor_mhz)
        hi = int(tcfg.frequency_ceiling_mhz)
        # Best effort: AxeOS /api/system/asic may carry a default/list we can
        # use to narrow the ceiling. Shapes vary across firmware, so this is
        # purely opportunistic and never fatal.
        try:
            if hasattr(drv, "fetch_asic_info"):
                info = await drv.fetch_asic_info()
                opts = info.get("frequencyOptions") or info.get("frequencies")
                if isinstance(opts, list) and opts:
                    nums = [float(x) for x in opts if isinstance(x, (int, float))]
                    if nums:
                        hi = int(min(hi, max(nums)))
                        lo = int(max(lo, min(nums)))
        except Exception:  # noqa: BLE001
            pass
        if lo > hi:
            lo, hi = hi, lo
        return lo, hi

    async def _poll_until_online(
        self, drv, cancel: asyncio.Event, timeout_s: int
    ) -> MinerSample | None:
        """Poll until the miner answers online, or timeout/cancel. None on fail."""
        waited = 0
        while waited < timeout_s:
            if cancel.is_set():
                return None
            s = await self._safe_poll(drv)
            if s and s.online:
                return s
            if await self._sleep_or_cancel(cancel, 5):
                return None
            waited += 5
        return None

    async def _safe_poll(self, drv) -> MinerSample | None:
        try:
            return await drv.poll()
        except Exception:  # noqa: BLE001
            return None

    async def _sleep_or_cancel(self, cancel: asyncio.Event, seconds: float) -> bool:
        """Sleep up to ``seconds``; return True if cancelled during the wait."""
        try:
            await asyncio.wait_for(cancel.wait(), timeout=max(0.0, seconds))
            return True
        except asyncio.TimeoutError:
            return False

    def _set_phase(
        self,
        miner_id: int,
        session_id: int,
        phase: str,
        current: dict | None = None,
        progress: float | None = None,
    ) -> None:
        prog = self._progress.get(miner_id)
        if prog is None:
            prog = {"session_id": session_id}
            self._progress[miner_id] = prog
        prog["phase"] = phase
        if current is not None:
            prog["current"] = current
        if progress is not None:
            prog["points_done"] = prog.get("points_done", 0)
            prog["progress"] = round(progress, 3)
        # Mirror coarse progress into the DB so the status survives a page
        # reload even before the next phase change.
        if progress is not None:
            asyncio.create_task(
                db.update_tuner_session(session_id, progress=round(progress, 3))
            )


# Global instance (used by main.py)
tuner_controller = TunerController()
