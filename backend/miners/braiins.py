# SPDX-License-Identifier: AGPL-3.0-only
"""Driver for Braiins BMM101 / BOSminer (Antminer + Braiins OS+).

Exposes the cgminer/BOSminer API on port 4028 (JSON-friendly).
Standard cgminer commands: ``version``, ``summary``, ``devs``, ``pools``.
Braiins extensions (BOSer/BOSminer): ``temps``, ``fans``, ``tunerstatus``.

On BMM 101 (Mini Miner) the standard cgminer commands expose very little
(``Temperature`` in DEVS is often 0). The Braiins extensions instead
properly return chip temp, fans, and tuning info.

Docs: https://docs.braiins.com/os/open-source-en/Development/1_api.html
"""
from __future__ import annotations

from typing import Any

from .base import (
    MinerDriver,
    MinerSample,
    assign_cgminer_pool_slots as _assign_cgminer_pool_slots,
    parse_cgminer_pool_entry as _parse_cgminer_pool_entry,
    parse_si_difficulty as _parse_si_difficulty,
)
from .cgminer_client import CgminerClient, CgminerError


class BraiinsDriver(MinerDriver):
    family = "braiins"
    DEFAULT_PORT = 4028
    can_restart = False  # niente reboot via API in BOSminer base

    def _client(self) -> CgminerClient:
        return CgminerClient(self.host, self.port, self.timeout)

    async def poll(self) -> MinerSample:
        cli = self._client()
        sample = MinerSample(family=self.family, host=self.host, online=False)

        try:
            version = await cli.call("version")
            sample.online = True
        except CgminerError as exc:
            sample.error = str(exc)
            return sample

        # Version/firmware: BOSminer returns {"VERSION":[{"BOSminer+":"...", "API":"3.7"}]}
        v_list = _arr(version, "VERSION")
        if v_list:
            v = v_list[0]
            sample.firmware_version = (
                v.get("BOSminer+") or v.get("BOSminer") or v.get("CGMiner") or v.get("API")
            )
            # No default: discovery applies the friendly "Braiins" label
            # itself (see backend/discovery.py:_default_model). Leaving
            # this None when the firmware doesn't report a model keeps
            # the driver honest if used outside the discovery flow.
            sample.model = v.get("Type") or v.get("PROD")

        # Summary
        try:
            summary = await cli.call("summary")
        except CgminerError:
            summary = {}
        s_list = _arr(summary, "SUMMARY")
        if s_list:
            s = s_list[0]
            # Preference: GHS 1m (1-minute average from the Braiins
            # firmware) → great trade-off between responsiveness and
            # stability. GHS 5s used to be the default but it fluctuated
            # too much. Fallback to 5m / av / MHS av if 1m isn't exposed
            # by older firmwares.
            ghs_1m = _opt_float(s.get("GHS 1m"))
            ghs_5m = _opt_float(s.get("GHS 5m"))
            ghs_av = _opt_float(s.get("GHS av"))
            ghs_5s = _opt_float(s.get("GHS 5s"))
            mhs_av = _opt_float(s.get("MHS av"))
            ths = None
            if ghs_1m is not None:
                ths = ghs_1m / 1000.0
            elif ghs_5m is not None:
                ths = ghs_5m / 1000.0
            elif ghs_av is not None:
                ths = ghs_av / 1000.0
            elif ghs_5s is not None:
                ths = ghs_5s / 1000.0
            elif mhs_av is not None:
                ths = mhs_av / 1_000_000.0
            sample.hashrate_ths = round(ths, 4) if ths is not None else None
            sample.uptime_s = _opt_int(s.get("Elapsed"))
            sample.accepted = _opt_int(s.get("Accepted"))
            sample.rejected = _opt_int(s.get("Rejected"))
            # `Best Share` is the best difficulty since BOSminer started:
            # it's session-scoped (resets on miner reboot). Most builds
            # return a raw number, but some BOS+ versions ship an SI
            # string ("1.18M"). The shared SI parser handles both.
            sample.best_difficulty = _parse_si_difficulty(s.get("Best Share"))

        # Devs: chip temp, fan, frequency
        try:
            devs = await cli.call("devs")
        except CgminerError:
            devs = {}
        d_list = _arr(devs, "DEVS") or _arr(devs, "DEVICES")
        if d_list:
            temps_chip: list[float] = []
            temps_vr: list[float] = []
            freqs: list[float] = []
            for dev in d_list:
                # On BMM `Temperature: 0` means "sensor not available",
                # not zero degrees: skip it so we don't bias temp_chip.
                t = _opt_float(dev.get("Chip Temp Avg") or dev.get("Temperature"))
                if t is not None and t > 0:
                    temps_chip.append(t)
                vr = _opt_float(dev.get("PCB Temperature"))
                if vr is not None and vr > 0:
                    temps_vr.append(vr)
                f = _opt_float(dev.get("Frequency") or dev.get("Nominal chip frequency"))
                if f is not None:
                    freqs.append(f)
            if temps_chip:
                sample.temp_chip_c = round(max(temps_chip), 1)
            if temps_vr:
                sample.temp_vr_c = round(max(temps_vr), 1)
            if freqs:
                sample.frequency_mhz = round(sum(freqs) / len(freqs), 1)
            sample.asic_count = len(d_list)

        # Stats (cgminer base): fan + power se presenti (Antminer + BOS+)
        try:
            stats = await cli.call("stats")
        except CgminerError:
            stats = {}
        st_list = _arr(stats, "STATS")
        if st_list:
            fans: dict[str, int] = {}
            power_vals: list[float] = []
            for entry in st_list:
                if not isinstance(entry, dict):
                    continue
                for k, v in entry.items():
                    if k.lower().startswith("fan") and "speed" not in k.lower():
                        rpm = _opt_int(v)
                        if rpm is not None:
                            fans[k] = rpm
                    if "power" in k.lower():
                        p = _opt_float(v)
                        if p is not None:
                            power_vals.append(p)
            if fans:
                sample.fans_extra = fans
                sample.fan_rpm = int(sum(fans.values()) / len(fans))
            if power_vals:
                sample.power_w = round(max(power_vals), 1)

        # Braiins extension: `temps` → detailed chip temperatures
        # Typical response: {"TEMPS":[{"ID":1,"Chip":62.0,"Board":58.0}, ...]}
        try:
            temps = await cli.call("temps")
        except CgminerError:
            temps = {}
        t_list = _arr(temps, "TEMPS")
        if t_list:
            chip_vals = []
            board_vals = []
            for t in t_list:
                c = _opt_float(t.get("Chip"))
                if c is not None and c > 0:
                    chip_vals.append(c)
                b = _opt_float(t.get("Board"))
                if b is not None and b > 0:
                    board_vals.append(b)
            if chip_vals:
                sample.temp_chip_c = round(max(chip_vals), 1)
            if board_vals:
                # "Board" temp is the PCB / regulator: I map it to temp_vr_c
                sample.temp_vr_c = round(max(board_vals), 1)

        # Braiins extension: `fans` → fan speeds
        # Typical response: {"FANS":[{"ID":0,"RPM":3500,"Speed":75}, ...]}
        try:
            fans_resp = await cli.call("fans")
        except CgminerError:
            fans_resp = {}
        f_list = _arr(fans_resp, "FANS")
        if f_list:
            fans_dict: dict[str, int] = {}
            speeds = []
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
                # On BMM the fan can read 0 (sensorless / not connected).
                rpm_vals = [v for v in fans_dict.values() if v > 0]
                if rpm_vals:
                    sample.fan_rpm = int(sum(rpm_vals) / len(rpm_vals))
            if speeds:
                sample.fan_pct = round(sum(speeds) / len(speeds), 1)

        # Braiins extension: `tunerstatus` → target/actual power, frequency
        # Typical response: {"TUNERSTATUS":[{"PowerLimit":35.0,"ApproximateChainPower":30.5, ...}]}
        try:
            tuner = await cli.call("tunerstatus")
        except CgminerError:
            tuner = {}
        tu_list = _arr(tuner, "TUNERSTATUS")
        if tu_list:
            t = tu_list[0]
            # On BMM the field is called "ApproximateChainPowerConsumption"
            # or "ApproximateMinerPowerConsumption" (both in W).
            # PowerLimit is the cap target (0 = no limit).
            p_eff = (
                _opt_float(t.get("ApproximateChainPowerConsumption"))
                or _opt_float(t.get("ApproximateMinerPowerConsumption"))
                or _opt_float(t.get("ApproximateChainPower"))
            )
            if p_eff is not None and p_eff > 0:
                sample.power_w = round(p_eff, 1)
            else:
                # Fallback: per-chain sum
                chains = t.get("TunerChainStatus")
                if isinstance(chains, list) and chains:
                    chain_powers = [
                        _opt_float(c.get("ApproximatePowerConsumptionWatt"))
                        for c in chains
                        if isinstance(c, dict)
                    ]
                    chain_powers = [p for p in chain_powers if p and p > 0]
                    if chain_powers:
                        sample.power_w = round(sum(chain_powers), 1)
                if sample.power_w is None:
                    p_lim = _opt_float(t.get("PowerLimit"))
                    if p_lim and p_lim > 0:
                        sample.power_w = round(p_lim, 1)
            # Target hashrate (useful info on its own): we don't
            # overwrite hashrate_ths, which is already the live value
            # from `summary`.

        # Pools — populate both the legacy scalar fields (pool_url /
        # worker, used by the dashboard cards, the DB and the alerts
        # pipeline) AND the new structured ``pools`` list, used by the
        # fleet-wide /pools page. Order of preference for the legacy
        # scalars: active stratum > first Alive > first row.
        try:
            pools = await cli.call("pools")
        except CgminerError:
            pools = {}
        p_list = _arr(pools, "POOLS")
        sample.pools = [_parse_cgminer_pool_entry(p) for p in p_list]
        # Sort by priority when present — keeps the UI deterministic
        # across polls even if the firmware reshuffles the array.
        sample.pools.sort(
            key=lambda p: (p.priority if p.priority is not None else 999, p.url or "")
        )
        # Tag primary/fallback slots from the sorted order so the Pools
        # page can filter/badge them (cgminer has no explicit slot flag).
        _assign_cgminer_pool_slots(sample.pools)
        # Legacy scalars: prefer the active pool, fall back to first Alive,
        # then to the first row.
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

        # Efficienza
        if sample.power_w and sample.hashrate_ths and sample.hashrate_ths > 0:
            sample.efficiency_w_per_ths = round(sample.power_w / sample.hashrate_ths, 2)

        sample.raw = {
            "version": version,
            "summary": summary,
            "devs": devs,
            "stats": stats,
            "pools": pools,
            "temps": temps,
            "fans": fans_resp,
            "tunerstatus": tuner,
        }
        return sample


def _arr(data: dict[str, Any], key: str) -> list[dict[str, Any]]:
    val = data.get(key)
    if isinstance(val, list):
        return [v for v in val if isinstance(v, dict)]
    if isinstance(val, dict):
        return [val]
    return []


def _opt_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _opt_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None
