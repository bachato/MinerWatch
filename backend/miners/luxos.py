# SPDX-License-Identifier: AGPL-3.0-only
"""Driver for Luxor LuxOS — custom Antminer/Whatsminer firmware.

LuxOS is Luxor's commercial firmware for Bitmain Antminer (S19/S21
series) and MicroBT Whatsminer. From a wire-protocol standpoint it
speaks a cgminer-compatible TCP API on port 4028 with a JSON-friendly
dialect very close to BOSminer/Braiins. The differences that matter to
us today are:

  * Firmware fingerprint: the ``version`` reply identifies as
    ``LUXminer x.y.z-<git>`` (we use this for discovery, see
    ``backend/discovery.py``).
  * A dedicated ``power`` command returns the estimated wattage —
    Braiins has to infer power from ``tunerstatus``, here we get it
    directly.
  * The extensions ``temps`` / ``fans`` exist and have the same shape
    as Braiins extensions, so the parsing logic is shared in spirit.

Docs: https://docs.luxor.tech/firmware/api/intro
Available commands: https://docs.luxor.tech/firmware/api/available_commands

================================================================================
FUTURE WORK — features intentionally left out of the read-only MVP
================================================================================

This MVP is **read-only**: every ``can_set_*`` capability flag is
False, and the only commands we issue are queries. The frontend will
therefore render the miner without any control button. This is on
purpose: write commands on LuxOS require a *session* (see "Session
handling" below), which is a state machine we'd rather get right in a
dedicated PR after the read path is battle-tested.

When we come back to add controls, the relevant commands are already
documented and grouped below by feature area so we have a roadmap
without re-reading the LuxOS docs from scratch.

──────────────────────────────────────────────────────────────────────────
1) Session handling (prerequisite for everything that writes)
──────────────────────────────────────────────────────────────────────────
LuxOS keeps a single global session for write commands. Only one
session at a time can exist on a given miner. The lifecycle:

  * ``session``  → returns the current active SessionID, or "" if
    nobody is holding one. Useful as a soft probe before logon.
  * ``logon``    → creates a new session, returns ``SessionID``.
    Fails if another session is already alive — handle that gracefully
    (backoff + retry, or surface as "miner busy" to the user).
  * ``logoff <SessionID>`` → drops the session cleanly. ALWAYS call
    this in a ``finally`` block.
  * ``kill``     → force-kills whatever session is active. Generates a
    warning in the miner log. Don't use unless we've decided that
    stealing is the right thing to do (almost never is).

Sessions expire after **60 seconds** of inactivity. Any successful
command using the SessionID refreshes the TTL. Implementation idea: an
async context manager ``async with self._session() as sid: …`` that
yields the SessionID and guarantees the logoff.

──────────────────────────────────────────────────────────────────────────
2) Basic write controls (parity with Braiins/Canaan)
──────────────────────────────────────────────────────────────────────────
Once the session helper is in place, flip the capability flags and
implement these methods (all require SessionID as the first parameter):

  * ``fanset <sid>,<id>,<speed>`` → ``set_fan_speed(percent)``
  * ``frequencyset <sid>,<board>,<chip>,<freq>`` → ``set_frequency(mhz)``
  * ``voltageset <sid>,<board>,<voltage>``      → ``set_voltage(mv)``
  * ``rebootdevice <sid>``                       → ``restart()``
  * ``disableboard <sid>,<id>`` / ``enableboard <sid>,<id>`` for
    isolating a faulty hashboard without stopping the rig.

Before each call, query ``limits`` to know the valid ranges for that
specific model and clamp the user input server-side. The LuxOS firmware
will reject out-of-range values, but clamping in the backend gives a
cleaner error and lets the frontend disable invalid slider positions.

──────────────────────────────────────────────────────────────────────────
3) Power Targeting (LuxOS-specific, S19 XP+ / S21 and later)
──────────────────────────────────────────────────────────────────────────
The killer feature of LuxOS for modern hardware. Instead of setting
frequency/voltage by hand, the user sets a power target in WATTS and
the firmware's AutoTuner continuously adjusts freq + volt to hold that
target — within the AutoTuner's thermal/stability limits (ATM).

  * ``powertargetset <sid>,<watts>`` → new capability ``can_set_power_target``
  * Read current target / status with ``autotunerget`` and ``atm``.
  * Read valid range with ``limits``. Slider min/max in the UI must
    come from this — they vary per model (e.g. S19j Pro vs S21).
  * NOT supported on all models. Check ``Compatible Miners`` in the
    LuxOS docs: as of writing, supported on S19 XP, S19 XP+,
    S19j XP, S21, S21 Pro, S21 XP, T21, S21 Hydro variants. Older S19
    series falls back to Preset Profiles instead.

Power Targeting is *safer* than frequencyset because the firmware owns
the freq/volt loop and the thermal envelope. The only real risk is UX
(user thinks in MHz, sees watts, drags the wrong way). Mitigation:
read current value as the slider default and require explicit confirm.

──────────────────────────────────────────────────────────────────────────
4) Curtailment (LuxOS-specific, "panic-button" for demand response)
──────────────────────────────────────────────────────────────────────────
  * ``curtail <sid>,<sleep|wakeup>`` drops the miner to ~25W in <5s
    and restores it in <10s. Designed for grid demand-response programs.
  * From a hardware-safety standpoint this is **less** risky than
    rebootdevice. The risk is purely operational: a stray click stops
    the rig. Mitigation when we expose it: confirmation modal where
    the user types the miner name (GitHub-delete-repo style), and a
    visible "Curtailed" badge in the dashboard so the user doesn't
    think the rig is broken when it returns 0 H/s.

──────────────────────────────────────────────────────────────────────────
5) Profile-based tuning (older Antminer 19 series without Power Targeting)
──────────────────────────────────────────────────────────────────────────
  * ``profiles``           → list available preset profiles (+1, -2, …)
  * ``profileget <id>``    → details of a single profile
  * ``profileset <sid>,<board>,<profile>`` → apply a profile
  * ``profilenew`` / ``profilerem`` / ``profilerestore`` → CRUD on
    user-defined profiles.

UI idea: dropdown next to the (eventual) Power Targeting slider — pick
one or the other depending on what the model supports.

──────────────────────────────────────────────────────────────────────────
6) Advanced Thermal Management (read-only is enough to start)
──────────────────────────────────────────────────────────────────────────
  * ``atm``           → current ATM state (active, throttling, etc.)
  * ``autotunerget``  → AutoTuner state (target, current, last action)
  * ``tempctrl``      → user-configured temperature thresholds
  * ``healthchipget`` → per-chip health + temperature topology

Even surfacing these as read-only on the miner detail page is useful:
the user can see "ATM is underclocking this miner by 8% because chip
temp is 78°C" and understand why hashrate is lower than expected.

──────────────────────────────────────────────────────────────────────────
7) Misc useful queries
──────────────────────────────────────────────────────────────────────────
  * ``events``        → recent miner events log
  * ``systemaudit``   → audit log (interesting for a "history" tab)
  * ``logs``          → tail of LuxOS logs
  * ``psuget``        → PSU configuration (nominal power, etc.)
  * ``updatecheck``   → are firmware updates available?

================================================================================
"""
from __future__ import annotations

from typing import Any

from .base import MinerDriver, MinerSample, parse_si_difficulty as _parse_si_difficulty
from .cgminer_client import CgminerClient, CgminerError


class LuxosDriver(MinerDriver):
    family = "luxos"
    DEFAULT_PORT = 4028

    # Read-only MVP: no write controls are wired up yet. See the
    # "FUTURE WORK" block at the top of this module for the roadmap.
    # When we add write controls, also remember to:
    #   - implement async session management (logon/logoff/refresh)
    #   - add per-call clamping via the ``limits`` command
    #   - add ``can_set_power_target`` (new capability flag) and an
    #     ``async def set_power_target(watts: int) -> bool`` method,
    #     plus a matching /control/power_target endpoint in main.py.
    can_set_fan = False
    can_set_frequency = False
    can_set_voltage = False
    can_restart = False

    def _client(self) -> CgminerClient:
        return CgminerClient(self.host, self.port, self.timeout)

    async def poll(self) -> MinerSample:
        cli = self._client()
        sample = MinerSample(family=self.family, host=self.host, online=False)

        # `version` is the smallest possible command and doubles as a
        # liveness probe. If it fails, the miner is offline (or not
        # speaking cgminer-API at all) and we return immediately.
        try:
            version = await cli.call("version")
            sample.online = True
        except CgminerError as exc:
            sample.error = str(exc)
            return sample

        # --- Identity ---
        # The LuxOS VERSION block keys can vary slightly across builds.
        # Be defensive: check the LUXminer-specific names first, then
        # fall back to cgminer-compatible ones. Real example:
        #   {"LUXminer":"0.1.0-15436f7140", "API":"3.7", "Type":"...",
        #    "PROD":"Antminer S19j Pro"}
        v_list = _arr(version, "VERSION")
        if v_list:
            v = v_list[0]
            sample.firmware_version = (
                v.get("LUXminer")
                or v.get("LUXminerVersion")
                or v.get("LUXMinerVersion")
                or v.get("CGMiner")
                or v.get("CGminer")
                or v.get("Miner")
                or v.get("API")
            )
            sample.model = (
                v.get("Type")
                or v.get("PROD")
                or v.get("MODEL")
                or v.get("Model")
                or "LuxOS"
            )
            mac = v.get("MAC")
            if isinstance(mac, str) and mac:
                sample.mac = _format_mac(mac)

        # --- Summary: hashrate + accepted/rejected/uptime/best share ---
        try:
            summary = await cli.call("summary")
        except CgminerError:
            summary = {}
        s_list = _arr(summary, "SUMMARY")
        if s_list:
            s = s_list[0]
            # Preference order mirrors Braiins/Canaan: prefer a moving
            # window (smoother, closer to what the pool sees from
            # shares) over the instantaneous 5s read. GHS 1m is the
            # sweet spot — responsive without being noisy.
            ghs_1m = _opt_float(s.get("GHS 1m"))
            ghs_5m = _opt_float(s.get("GHS 5m"))
            ghs_av = _opt_float(s.get("GHS av"))
            ghs_5s = _opt_float(s.get("GHS 5s"))
            mhs_av = _opt_float(s.get("MHS av"))
            mhs_5m = _opt_float(s.get("MHS 5m"))
            mhs_1m = _opt_float(s.get("MHS 1m"))
            ths = None
            if ghs_1m is not None:
                ths = ghs_1m / 1000.0
            elif ghs_5m is not None:
                ths = ghs_5m / 1000.0
            elif ghs_av is not None:
                ths = ghs_av / 1000.0
            elif ghs_5s is not None:
                ths = ghs_5s / 1000.0
            elif mhs_5m is not None:
                ths = mhs_5m / 1_000_000.0
            elif mhs_1m is not None:
                ths = mhs_1m / 1_000_000.0
            elif mhs_av is not None:
                ths = mhs_av / 1_000_000.0
            sample.hashrate_ths = round(ths, 4) if ths is not None else None
            sample.uptime_s = _opt_int(s.get("Elapsed"))
            sample.accepted = _opt_int(s.get("Accepted"))
            sample.rejected = _opt_int(s.get("Rejected"))
            # `Best Share` is session-scoped on LuxOS (resets at miner
            # reboot). Either a raw number or an SI-suffixed string
            # depending on the build — parse_si_difficulty handles both.
            sample.best_difficulty = _parse_si_difficulty(s.get("Best Share"))

        # --- Devs: per-board details (temp, frequency, asic count) ---
        try:
            devs = await cli.call("devs")
        except CgminerError:
            devs = {}
        d_list = _arr(devs, "DEVS") or _arr(devs, "DEVICES")
        if d_list:
            temps_chip: list[float] = []
            freqs: list[float] = []
            for dev in d_list:
                # Some LuxOS builds zero out `Temperature` when the
                # sensor is unavailable, same trap as Braiins BMM.
                t = _opt_float(
                    dev.get("Chip Temp Avg")
                    or dev.get("Temperature")
                    or dev.get("Chip Temp")
                )
                if t is not None and t > 0:
                    temps_chip.append(t)
                f = _opt_float(
                    dev.get("Frequency")
                    or dev.get("Nominal chip frequency")
                )
                if f is not None:
                    freqs.append(f)
            if temps_chip:
                sample.temp_chip_c = round(max(temps_chip), 1)
            if freqs:
                sample.frequency_mhz = round(sum(freqs) / len(freqs), 1)
            sample.asic_count = len(d_list)

        # --- Temps extension: per-board chip + board (PCB) temps ---
        # Same shape as Braiins: {"TEMPS":[{"ID":0,"Chip":62.0,"Board":58.0}, ...]}
        # When present, this is more accurate than the `devs` value.
        try:
            temps = await cli.call("temps")
        except CgminerError:
            temps = {}
        t_list = _arr(temps, "TEMPS")
        if t_list:
            chip_vals: list[float] = []
            board_vals: list[float] = []
            for t in t_list:
                c = _opt_float(t.get("Chip"))
                if c is not None and c > 0:
                    chip_vals.append(c)
                b = _opt_float(t.get("Board") or t.get("PCB"))
                if b is not None and b > 0:
                    board_vals.append(b)
            if chip_vals:
                sample.temp_chip_c = round(max(chip_vals), 1)
            if board_vals:
                # The board/PCB sensor is the closest analogue to a VR
                # temperature on Antminer hardware — map it to temp_vr_c
                # for consistency with how Braiins reports it.
                sample.temp_vr_c = round(max(board_vals), 1)

        # --- Fans extension: per-fan RPM and PWM% ---
        # Shape: {"FANS":[{"ID":0,"RPM":3500,"Speed":75}, ...]}
        try:
            fans_resp = await cli.call("fans")
        except CgminerError:
            fans_resp = {}
        f_list = _arr(fans_resp, "FANS")
        if f_list:
            fans_dict: dict[str, int] = {}
            speeds: list[float] = []
            for fdef in f_list:
                rpm = _opt_int(fdef.get("RPM"))
                if rpm is not None:
                    fid = fdef.get("ID", len(fans_dict))
                    fans_dict[f"fan{fid}"] = rpm
                speed = _opt_float(fdef.get("Speed"))
                if speed is not None:
                    speeds.append(speed)
            if fans_dict:
                sample.fans_extra = fans_dict
                rpm_vals = [v for v in fans_dict.values() if v > 0]
                if rpm_vals:
                    sample.fan_rpm = int(sum(rpm_vals) / len(rpm_vals))
            if speeds:
                sample.fan_pct = round(sum(speeds) / len(speeds), 1)

        # --- Power: dedicated LuxOS command, returns watts directly ---
        # Field names vary slightly across builds: be defensive and
        # accept ``Watts``, ``Power``, ``PowerEstimate``, ``Watt``.
        try:
            power = await cli.call("power")
        except CgminerError:
            power = {}
        p_list = _arr(power, "POWER")
        if p_list:
            p = p_list[0]
            watts = (
                _opt_float(p.get("Watts"))
                or _opt_float(p.get("Watt"))
                or _opt_float(p.get("Power"))
                or _opt_float(p.get("PowerEstimate"))
                or _opt_float(p.get("Estimate"))
            )
            if watts is not None and watts > 0:
                sample.power_w = round(watts, 1)

        # --- Stats fallback: some builds put power inside STATS ---
        # We only fall back here if `power` didn't yield anything, to
        # avoid double-reading on the happy path. Also useful as a
        # secondary source for fan RPM on older firmware that doesn't
        # implement the `fans` extension yet.
        if sample.power_w is None or sample.fan_rpm is None:
            try:
                stats = await cli.call("stats")
            except CgminerError:
                stats = {}
            st_list = _arr(stats, "STATS")
            if st_list:
                fans_fallback: dict[str, int] = {}
                power_vals: list[float] = []
                for entry in st_list:
                    if not isinstance(entry, dict):
                        continue
                    for k, v in entry.items():
                        if not isinstance(k, str):
                            continue
                        kl = k.lower()
                        if kl.startswith("fan") and "speed" not in kl:
                            rpm = _opt_int(v)
                            if rpm is not None:
                                fans_fallback[k] = rpm
                        if "power" in kl or "watt" in kl:
                            pv = _opt_float(v)
                            if pv is not None:
                                power_vals.append(pv)
                if sample.fan_rpm is None and fans_fallback:
                    sample.fans_extra = sample.fans_extra or fans_fallback
                    rpm_vals = [v for v in fans_fallback.values() if v > 0]
                    if rpm_vals:
                        sample.fan_rpm = int(sum(rpm_vals) / len(rpm_vals))
                if sample.power_w is None and power_vals:
                    sample.power_w = round(max(power_vals), 1)
        else:
            stats = {}

        # --- Pools: active pool + worker ---
        try:
            pools = await cli.call("pools")
        except CgminerError:
            pools = {}
        p_list = _arr(pools, "POOLS")
        # Stratum Active = true wins; fall back to first Alive pool.
        for pool in p_list or []:
            if str(pool.get("Stratum Active")).lower() == "true":
                sample.pool_url = pool.get("Stratum URL") or pool.get("URL")
                sample.worker = pool.get("User")
                break
        if not sample.pool_url:
            for pool in p_list or []:
                if str(pool.get("Status", "")).lower() == "alive":
                    sample.pool_url = pool.get("Stratum URL") or pool.get("URL")
                    sample.worker = pool.get("User")
                    break

        # --- Efficiency: derived, not read from the wire ---
        if sample.power_w and sample.hashrate_ths and sample.hashrate_ths > 0:
            sample.efficiency_w_per_ths = round(sample.power_w / sample.hashrate_ths, 2)

        sample.raw = {
            "version": version,
            "summary": summary,
            "devs": devs,
            "temps": temps,
            "fans": fans_resp,
            "power": power,
            "pools": pools,
            "stats": stats,
        }
        return sample


# ============================================================================
# Helpers (shared in spirit with braiins.py — kept local so the two
# drivers stay independent and a quirk in one doesn't bleed into the other)
# ============================================================================

def _arr(data: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """Return data[key] as a list of dicts, tolerating dict-shaped sections.

    Some legacy cgminer builds return ``"VERSION": {...}`` (single dict)
    instead of the canonical ``"VERSION": [{...}]`` list-of-one. We
    normalize so the callers don't have to branch.
    """
    val = data.get(key)
    if isinstance(val, list):
        return [v for v in val if isinstance(v, dict)]
    if isinstance(val, dict):
        return [val]
    return []


def _opt_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        s = value.split()[0] if value.split() else value
        s = s.rstrip("%")
        try:
            return float(s)
        except (TypeError, ValueError):
            return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _opt_int(value: Any) -> int | None:
    f = _opt_float(value)
    if f is None:
        return None
    return int(f)


def _format_mac(raw: str) -> str:
    """Normalize MACs to the colon-separated uppercase form."""
    raw = raw.strip().upper().replace("-", "").replace(":", "")
    if len(raw) != 12:
        return raw
    return ":".join(raw[i : i + 2] for i in range(0, 12, 2))
