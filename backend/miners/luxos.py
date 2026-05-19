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

import asyncio
from typing import Any

from .base import (
    BoardSnapshot,
    FanSnapshot,
    MinerDriver,
    MinerSample,
    parse_cgminer_pool_entry as _parse_cgminer_pool_entry,
    parse_si_difficulty as _parse_si_difficulty,
)
from .cgminer_client import CgminerClient, CgminerError


# Cap parallelism of per-board reads. The LuxOS API server is a small
# cgminer-style fork that historically degrades when more than ~10
# concurrent connections are open. We issue 3 new commands per board
# (frequencyget, voltageget, healthchipget) — for a 3-board S19 that's
# 9 sockets if we fire them all at once, plus whatever the existing
# sequential reads are doing. A semaphore at 4 keeps us comfortably
# under the threshold while still cutting wall-clock time by ~3x vs.
# pure-serial execution.
_PER_BOARD_PARALLELISM = 4


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
            # Do NOT default to a literal "LuxOS" here: discovery used to
            # check for ``"lux" in model.lower()`` and the default value
            # caused a false positive on Braiins-OS miners that lack
            # ``Type``/``PROD``. Discovery now fingerprints by raw key
            # names (see ``backend/discovery.py:_cgminer_fingerprint``)
            # and applies the friendly "LuxOS" label there, so the
            # driver can leave model unset when the firmware doesn't
            # report one — safer for any future caller that might use
            # this driver outside the discovery flow.
            sample.model = (
                v.get("Type")
                or v.get("PROD")
                or v.get("MODEL")
                or v.get("Model")
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

        # --- Temps extension: per-board sensors ---
        # The earlier shape comment ("Chip"/"Board"/"PCB") was wrong for
        # LuxOS. The actual payload exposes 4 sensors per board, named
        # by physical *position* (BottomLeft/BottomRight/TopLeft/
        # TopRight) plus a sibling METADATA section that maps each
        # position to a human label ("Board Outlet", "Board Inlet",
        # "Water Inlet", "Water Outlet"). On the S19j Pro KuroPro the
        # labels are typically "Board Exhaust" / "Board Intake" (top
        # and bottom). Real example:
        #   {
        #     "METADATA":[{"BottomLeft":{"Label":"Board Outlet",...},...}],
        #     "TEMPS":[{"ID":0,"TEMP":1,"BottomLeft":58,"BottomRight":42,
        #              "TopLeft":56,"TopRight":48}, ...]
        #   }
        # The old code looked for "Chip"/"Board" keys that don't exist
        # in LuxOS and silently fell back to `devs.Temperature` for the
        # max chip temp. We now correctly aggregate across all 4 sensors
        # per board and keep the per-board breakdown for the BoardSnapshot
        # builder further down (see `_temps_for_board`).
        try:
            temps = await cli.call("temps")
        except CgminerError:
            temps = {}
        t_list = _arr(temps, "TEMPS")
        if t_list:
            all_temp_vals: list[float] = []
            for t in t_list:
                for pos in _TEMP_POSITIONS:
                    v = _opt_float(t.get(pos))
                    if v is not None and v > 0:
                        all_temp_vals.append(v)
                # Also accept the legacy/Braiins-style "Chip" key if
                # ever present on some build — additive, not exclusive.
                for legacy in ("Chip", "Board", "PCB"):
                    v = _opt_float(t.get(legacy))
                    if v is not None and v > 0:
                        all_temp_vals.append(v)
            if all_temp_vals:
                sample.temp_chip_c = round(max(all_temp_vals), 1)

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

        # --- Pools: structured list + legacy scalars ---
        # See the parallel comment in ``braiins.py`` — the new
        # ``pools`` list is what feeds the fleet-wide Pools page, while
        # ``pool_url`` / ``worker`` stay populated for the existing
        # dashboard cards, the time-series DB and the alerts.
        try:
            pools = await cli.call("pools")
        except CgminerError:
            pools = {}
        p_list = _arr(pools, "POOLS")
        sample.pools = [_parse_cgminer_pool_entry(p) for p in p_list]
        sample.pools.sort(
            key=lambda p: (p.priority if p.priority is not None else 999, p.url or "")
        )
        chosen = None
        for p in sample.pools:
            if p.active:
                chosen = p
                break
        if chosen is None:
            for p in sample.pools:
                if p.status == "alive":
                    chosen = p
                    break
        if chosen is None and sample.pools:
            chosen = sample.pools[0]
        if chosen is not None:
            sample.pool_url = chosen.url
            sample.worker = chosen.user

        # --- Structured fan list ---
        # Mirrors what we put in the legacy `fans_extra` dict but also
        # carries the physical connector label (e.g. "J12 | J14") that
        # LuxOS exposes in the `FAN` field. The frontend uses this list
        # to render one tile per fan with the connector as a tooltip;
        # the legacy fields above stay populated so the time-series DB
        # and the other-family drivers still work unchanged.
        for fdef in f_list or []:
            fid = _opt_int(fdef.get("ID"))
            sample.fans.append(
                FanSnapshot(
                    id=fid if fid is not None else len(sample.fans),
                    rpm=_opt_int(fdef.get("RPM")),
                    speed_pct=_opt_float(fdef.get("Speed")),
                    connector=fdef.get("FAN") if isinstance(fdef.get("FAN"), str) else None,
                )
            )

        # --- Per-board structured snapshot ---
        # For each board surfaced by `devs`, fan out three additional
        # read-only LuxOS queries: `frequencyget`, `voltageget`,
        # `healthchipget`. These are throttled by a semaphore so we
        # don't open more than _PER_BOARD_PARALLELISM sockets at once
        # against the small API server.
        per_board_raw: dict[int, dict[str, Any]] = {}
        if d_list:
            board_ids: list[int] = []
            for i, dev in enumerate(d_list):
                bid = _opt_int(dev.get("ID"))
                if bid is None:
                    bid = i
                board_ids.append(bid)

            sem = asyncio.Semaphore(_PER_BOARD_PARALLELISM)

            async def _call(cmd: str, bid: int) -> dict[str, Any] | None:
                async with sem:
                    try:
                        return await self._client().call(cmd, parameter=str(bid))
                    except CgminerError:
                        return None

            tasks = []
            for bid in board_ids:
                tasks.append(_call("frequencyget", bid))
                tasks.append(_call("voltageget", bid))
                tasks.append(_call("healthchipget", bid))
            results = await asyncio.gather(*tasks)

            # Pre-compute the position-to-label map once: METADATA is
            # the same shape across all TEMPS entries, so we don't want
            # to re-walk it per board.
            temps_metadata = _temps_metadata_labels(temps)

            for idx, dev in enumerate(d_list):
                bid = board_ids[idx]
                freq_resp = results[idx * 3]
                volt_resp = results[idx * 3 + 1]
                health_resp = results[idx * 3 + 2]
                per_board_raw[bid] = {
                    "frequencyget": freq_resp or {},
                    "voltageget": volt_resp or {},
                    "healthchipget": health_resp or {},
                }

                bs = BoardSnapshot(id=bid)
                bs.status = (
                    dev.get("Status") if isinstance(dev.get("Status"), str) else None
                )
                en = dev.get("Enabled")
                if isinstance(en, str):
                    bs.enabled = en.strip().upper() == "Y"
                connector = dev.get("Connector")
                if isinstance(connector, str) and connector:
                    bs.connector = connector

                # Hashrate (MHS in `devs` is MH/s — divide by 1e6 to TH/s)
                mhs_1m = _opt_float(dev.get("MHS 1m"))
                mhs_5s = _opt_float(dev.get("MHS 5s"))
                nominal_mhs = _opt_float(dev.get("Nominal MHS"))
                if mhs_1m is not None:
                    bs.hashrate_ths = round(mhs_1m / 1_000_000.0, 4)
                if mhs_5s is not None:
                    bs.hashrate_5s_ths = round(mhs_5s / 1_000_000.0, 4)
                if nominal_mhs is not None:
                    bs.nominal_ths = round(nominal_mhs / 1_000_000.0, 4)

                # Temperatures: pick all four sensors for this board ID.
                board_temp_vals: list[float] = []
                for t in t_list or []:
                    if _opt_int(t.get("ID")) != bid:
                        continue
                    for pos in _TEMP_POSITIONS:
                        v = _opt_float(t.get(pos))
                        if v is None or v <= 0:
                            continue
                        bs.temps_extra[pos] = v
                        label = temps_metadata.get(pos)
                        if label:
                            bs.temps_labels[pos] = label
                        board_temp_vals.append(v)
                # Fall back to the chip temp reported in `devs` if the
                # temps extension didn't carry per-board sensors.
                dev_temp = _opt_float(
                    dev.get("Chip Temp Avg")
                    or dev.get("Temperature")
                    or dev.get("Chip Temp")
                )
                if dev_temp is not None and dev_temp > 0:
                    board_temp_vals.append(dev_temp)
                if board_temp_vals:
                    bs.temp_chip_c = round(max(board_temp_vals), 1)

                # Frequency (per-board)
                bs.frequency_mhz = _parse_frequency_response(freq_resp, bid)
                # Fallback: some older LuxOS builds include Frequency
                # in `devs` directly.
                if bs.frequency_mhz is None:
                    bs.frequency_mhz = _opt_float(
                        dev.get("Frequency") or dev.get("Nominal chip frequency")
                    )

                # Voltage (per-board, in volts)
                bs.voltage_v = _parse_voltage_response(volt_resp, bid)

                # Chip health
                chips_info, counts = _parse_healthchip_response(health_resp)
                bs.chips = chips_info
                bs.chips_total = counts["total"] if counts else None
                bs.chips_healthy = counts.get("healthy") if counts else None
                bs.chips_unhealthy = counts.get("unhealthy") if counts else None
                bs.chips_unknown = counts.get("unknown") if counts else None

                sample.boards.append(bs)

            # --- Aggregate counts ---
            sample.board_count = len(sample.boards)
            chip_totals = [
                b.chips_total for b in sample.boards if b.chips_total is not None
            ]
            if chip_totals:
                sample.chip_count = sum(chip_totals)
            # ``asic_count`` historically meant "value displayed under
            # ASIC count in the UI". Older callers expect a number; new
            # ones should look at chip_count/board_count explicitly. We
            # prefer the chip count if known (matches LuxOS's own
            # dashboard), otherwise keep the board count for parity
            # with the previous behaviour.
            sample.asic_count = sample.chip_count or sample.board_count

            # Promote per-board freq/voltage into the legacy aggregate
            # fields when the existing reads didn't populate them. This
            # lets the existing "Frequency" and "Voltage" tiles in
            # LiveStats keep showing something sensible on LuxOS.
            if sample.frequency_mhz is None:
                fr_vals = [b.frequency_mhz for b in sample.boards if b.frequency_mhz]
                if fr_vals:
                    sample.frequency_mhz = round(sum(fr_vals) / len(fr_vals), 1)
            if sample.voltage_mv is None:
                v_vals = [b.voltage_v for b in sample.boards if b.voltage_v]
                if v_vals:
                    # voltageget returns volts; voltage_mv expects mV.
                    sample.voltage_mv = round(
                        (sum(v_vals) / len(v_vals)) * 1000.0, 0
                    )

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
            "per_board": per_board_raw,
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


# Sensor positions used by the LuxOS ``temps`` extension. Each TEMPS
# entry can carry up to four readings keyed by these names; METADATA
# carries the human-readable label (e.g. "Board Outlet") that goes
# with each position.
_TEMP_POSITIONS = ("BottomLeft", "BottomRight", "TopLeft", "TopRight")


def _temps_metadata_labels(temps: dict[str, Any]) -> dict[str, str]:
    """Extract the position→label map from a ``temps`` response.

    Shape example::

        {"METADATA":[{"BottomLeft":{"Label":"Board Outlet",...},
                      "BottomRight":{"Label":"Water Inlet",...},
                      ...}]}

    Returns ``{}`` when the firmware doesn't include METADATA — older
    LuxOS builds omit it, in which case the frontend falls back to
    rendering the raw position name (BottomLeft, …).
    """
    metas = _arr(temps, "METADATA")
    if not metas:
        return {}
    meta = metas[0]
    out: dict[str, str] = {}
    for pos in _TEMP_POSITIONS:
        entry = meta.get(pos)
        if isinstance(entry, dict):
            label = entry.get("Label")
            if isinstance(label, str) and label.strip():
                out[pos] = label.strip()
    return out


def _parse_frequency_response(resp: dict[str, Any] | None, board_id: int) -> float | None:
    """Pull the average operating frequency (MHz) out of a ``frequencyget`` reply.

    LuxOS builds vary: some return a single ``FREQUENCY`` entry with a
    board-wide value, others return a per-chip list. We tolerate both
    by looking for the most natural keys first and falling back to
    averaging whatever per-chip numbers we find.
    """
    if not resp:
        return None
    f_list = _arr(resp, "FREQUENCY") or _arr(resp, "FREQ") or _arr(resp, "FREQS")
    if not f_list:
        return None
    # Single-entry, board-wide shape.
    if len(f_list) == 1:
        only = f_list[0]
        for key in ("Frequency", "AvgFrequency", "Avg Frequency", "Avg", "Value"):
            v = _opt_float(only.get(key))
            if v is not None:
                return round(v, 1)
    # Per-chip list: average the frequencies we can parse.
    vals: list[float] = []
    for entry in f_list:
        # Filter to chips on this board when the field is present.
        b = _opt_int(entry.get("Board"))
        if b is not None and b != board_id:
            continue
        v = _opt_float(entry.get("Frequency"))
        if v is not None and v > 0:
            vals.append(v)
    if not vals:
        return None
    return round(sum(vals) / len(vals), 1)


def _parse_voltage_response(resp: dict[str, Any] | None, board_id: int) -> float | None:
    """Pull the board voltage (V) out of a ``voltageget`` reply.

    Shape example::

        {"VOLTAGE":[{"Board":0,"IsOnBoard":false,"Voltage":11.88}]}
    """
    if not resp:
        return None
    v_list = _arr(resp, "VOLTAGE")
    if not v_list:
        return None
    # Prefer the entry matching the requested board id.
    for entry in v_list:
        b = _opt_int(entry.get("Board"))
        if b is not None and b != board_id:
            continue
        v = _opt_float(entry.get("Voltage"))
        if v is not None:
            return round(v, 2)
    # Fall back to the first entry.
    v = _opt_float(v_list[0].get("Voltage"))
    return round(v, 2) if v is not None else None


def _parse_healthchip_response(
    resp: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Return (chips, counts) from a ``healthchipget`` reply.

    Each chip dict is a compact, frontend-friendly projection of the
    fields LuxOS returns. We strip the internal serial-style keys
    (BadHashCount, DoubleHashCount, ReadErrors, …) that aren't useful
    to surface and would just bloat the JSON payload.

    Counts use the same buckets as the LuxOS dashboard so the
    "77 Healthy / 0 Unhealthy / 0 Unknown" tile maps 1:1.
    """
    if not resp:
        return [], {}
    c_list = _arr(resp, "CHIPS")
    if not c_list:
        return [], {}
    chips: list[dict[str, Any]] = []
    healthy = unhealthy = unknown = 0
    for entry in c_list:
        # LuxOS encodes Healthy as "Y", "N", or the string "Unknown".
        raw_health = entry.get("Healthy")
        if isinstance(raw_health, str):
            h = raw_health.strip()
        else:
            h = "Unknown"
        if h == "Y":
            healthy += 1
            health_label = "Y"
        elif h == "N":
            unhealthy += 1
            health_label = "N"
        else:
            unknown += 1
            health_label = "Unknown"

        chips.append(
            {
                "chip": _opt_int(entry.get("Chip")),
                "row": _opt_int(entry.get("Row")),
                "column": _opt_int(entry.get("Column")),
                "domain": _opt_int(entry.get("Domain")),
                "healthy": health_label,
                "is_checking": bool(entry.get("IsChecking")) if "IsChecking" in entry else None,
                # Optional fields — LuxOS omits these when health == "Unknown".
                "frequency": _opt_float(entry.get("Frequency")),
                "ghs_1m": _opt_float(entry.get("GHS 1m")),
                "ghs_5m": _opt_float(entry.get("GHS 5m")),
                "ghs_15m": _opt_float(entry.get("GHS 15m")),
                "score": _opt_float(entry.get("Score")),
                # `ChipTemp` is only populated by S21/T21-class hardware;
                # on S19 the per-chip temperature isn't exposed.
                "chip_temp_c": _opt_float(entry.get("ChipTemp")),
                "hash_count": _opt_int(entry.get("HashCount")),
                "hash_expected": _opt_int(entry.get("HashExpected")),
            }
        )
    counts = {
        "total": len(chips),
        "healthy": healthy,
        "unhealthy": unhealthy,
        "unknown": unknown,
    }
    return chips, counts
