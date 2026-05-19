# SPDX-License-Identifier: AGPL-3.0-only
"""Driver for Canaan Avalon (Nano 3s, Avalon Q, A10, etc.).

Protocol: cgminer-API on port 4028 with the Avalon dialect (estats /
version / ascset). The poll runs ``version`` + ``estats`` + ``summary``
+ ``pools`` sequentially (the API doesn't support concurrent calls on
the same device).

All the interesting Nano 3s data lives in the ``MM ID0`` field, which
is a string with sub-blocks like ``Foo[bar] Baz[qux]``. Real example:

    Ver[Nano3s-25021401] FW[Release] DNA[02010000a8c8e798]
    SYSTEMSTATU[Work: In Work, Hash Board: 1] Elapsed[177873]
    HW[0] DH[2.897%] ITemp[-273] OTemp[34] TMax[66] TAvg[61] TarT[90]
    Fan1[2600] FanR[55%] PS[0 0 27458 4 0 3990 130]
    GHSspd[6105.59] GHSmm[6307.44] GHSavg[6227.17] WU[86992.60]
    Freq[432.25] MTmax[66] MTavg[61] TA[12]
    PLL0[795 506 412 111] SF0[414 432 453 474]
    PVT_T0[55 59 65 ...] PVT_V0[321 313 316 ...]
    WORKMODE[2] WORKLEVEL[0] MPO[133] CALIALL[7]

Reference: Avalon API manual + reverse-engineering of the Nano3s firmware
``MM319 / 25021401_56abae7``.
"""
from __future__ import annotations

import re
from typing import Any

from .base import (
    MinerDriver,
    MinerSample,
    parse_cgminer_pool_entry as _parse_cgminer_pool_entry,
    parse_si_difficulty as _parse_si_difficulty,
)
from .cgminer_client import CgminerClient, CgminerError


class CanaanDriver(MinerDriver):
    family = "canaan"
    DEFAULT_PORT = 4028
    # Avalon firmware accepts `ascset|0,fan-spd,<value>` with value in
    # {-1 (auto), 15..100 (PWM%)}. Below 15 the firmware rejects it.
    can_set_fan = True
    can_set_frequency = True
    can_set_voltage = True
    can_set_workmode = True
    can_restart = True
    fan_min_pct = 15  # firmware minimum, below this it goes to auto

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

        # --- Identity (from `version`) ---
        v_section = _first_section(version, ("VERSION",))
        if v_section:
            sample.firmware_version = (
                str(
                    v_section.get("LVERSION")
                    or v_section.get("CGVERSION")
                    or v_section.get("VERSION")
                    or v_section.get("CGMiner")
                    or ""
                )
                or None
            )
            sample.model = str(v_section.get("PROD") or v_section.get("MODEL") or "") or None
            mac = v_section.get("MAC")
            if isinstance(mac, str) and mac:
                sample.mac = _format_mac(mac)

        # --- Summary: hashrate, accepted/rejected, best share, uptime ---
        try:
            summary = await cli.call("summary")
        except CgminerError:
            summary = {}
        s_section = _first_section(summary, ("SUMMARY",))
        if s_section:
            # Prefer values that the pool actually "sees" from shares
            # (computed from valid nonces). Order:
            #   1. MHS 5m  → 5-minute moving window, smooth and accurate
            #   2. MHS 1m  → 1-minute moving window
            #   3. MHS av  → cumulative average since startup (very stable at steady state)
            #   4. MHS 5s  → last-resort fallback (instantaneous, noisy)
            # MHS 5s used to be the default: too jittery, and on Avalon
            # it diverged noticeably from the pool's view because it
            # ignores HW errors and stale-rejected shares.
            mhs = (
                _opt_float(s_section.get("MHS 5m"))
                or _opt_float(s_section.get("MHS 1m"))
                or _opt_float(s_section.get("MHS av"))
                or _opt_float(s_section.get("MHS 5s"))
            )
            if mhs is not None:
                sample.hashrate_ths = round(mhs / 1_000_000.0, 4)
            sample.accepted = _opt_int(s_section.get("Accepted"))
            sample.rejected = _opt_int(s_section.get("Rejected"))
            # `Best Share` is session-scoped on Avalon firmware (resets
            # at every miner reboot). Numeric on stock cgminer, but the
            # shared SI parser is idempotent on numbers, so it's safe.
            sample.best_difficulty = _parse_si_difficulty(s_section.get("Best Share"))
            sample.uptime_s = _opt_int(s_section.get("Elapsed"))

        # --- Stats: the "MM ID0" field carries everything else ---
        try:
            stats = await cli.call("estats")
        except CgminerError:
            try:
                stats = await cli.call("stats")
            except CgminerError:
                stats = {}
        _enrich_from_estats(sample, stats)

        # --- Pools: active pool + worker ---
        try:
            pools = await cli.call("pools")
        except CgminerError:
            pools = {}
        _enrich_from_pools(sample, pools)

        # Efficiency
        if sample.power_w and sample.hashrate_ths and sample.hashrate_ths > 0:
            sample.efficiency_w_per_ths = round(sample.power_w / sample.hashrate_ths, 2)

        sample.raw = {
            "version": version,
            "summary": summary,
            "stats": stats,
            "pools": pools,
        }
        return sample

    async def restart(self) -> bool:
        try:
            await self._client().call("ascset", "0,reboot,0")
        except CgminerError:
            return False
        return True

    # ---- Fan controls ----

    async def set_fan_speed(self, percent: int) -> bool:
        """Set fan PWM in % (15-100). Below 15 → firmware auto."""
        value = int(percent)
        if value < self.fan_min_pct:
            return await self.set_auto_fan(True)
        value = min(100, value)
        try:
            resp = await self._client().call("ascset", f"0,fan-spd,{value}")
        except CgminerError:
            return False
        return _ascset_ok(resp)

    async def set_auto_fan(self, enabled: bool = True) -> bool:
        """Firmware auto mode (handled internally by Avalon)."""
        if not enabled:
            # "Disabling auto" means going back to manual; the default
            # that makes most sense is 50% (neutral thermal zone).
            return await self.set_fan_speed(50)
        try:
            resp = await self._client().call("ascset", "0,fan-spd,-1")
        except CgminerError:
            return False
        return _ascset_ok(resp)

    # ---- ASIC controls ----

    async def set_frequency(self, mhz: int) -> bool:
        """ASIC frequency: the Avalon firmware expects ``F0:F1:F2:F3-mod-miner-asic``.
        We send the same value to all 4 PLLs ("flat" config) broadcast to the whole chip.
        """
        value = max(200, min(1195, int(mhz)))  # firmware max is 1195 MHz
        try:
            resp = await self._client().call(
                "ascset", f"0,frequency,{value}:{value}:{value}:{value}-0-0-0"
            )
        except CgminerError:
            return False
        return _ascset_ok(resp)

    async def set_voltage(self, millivolts: int) -> bool:
        """Chip voltage in mV. The valid range is decided by the firmware."""
        try:
            resp = await self._client().call("ascset", f"0,voltage,{int(millivolts)}")
        except CgminerError:
            return False
        return _ascset_ok(resp)

    async def set_workmode(self, mode: int) -> bool:
        """Workmode 0=Low, 1=Mid, 2=High."""
        if mode not in (0, 1, 2):
            return False
        try:
            resp = await self._client().call("ascset", f"0,workmode,set,{int(mode)}")
        except CgminerError:
            return False
        return _ascset_ok(resp)


def _ascset_ok(resp: dict[str, Any]) -> bool:
    """Verify that `ascset` succeeded.

    cgminer JSON: {"STATUS":[{"STATUS":"S",...}]}, or legacy pipe-text
    form where `_section` is "STATUS" with "S".
    """
    if not isinstance(resp, dict):
        return False
    status_list = resp.get("STATUS")
    if isinstance(status_list, list) and status_list:
        first = status_list[0]
        if isinstance(first, dict):
            return str(first.get("STATUS", "")).upper() in ("S", "I")
    if isinstance(status_list, dict):
        return str(status_list.get("STATUS", "")).upper() in ("S", "I")
    return False


# ============================================================================
# Avalon parsing helpers
# ============================================================================

def _first_section(data: dict[str, Any], names: tuple[str, ...]) -> dict[str, Any] | None:
    for name in names:
        section = data.get(name)
        if isinstance(section, list):
            return section[0] if section else None
        if isinstance(section, dict):
            return section
    return None


def _enrich_from_estats(sample: MinerSample, stats: dict[str, Any]) -> None:
    """Extract fields from the ``MM ID0`` block of estats."""
    section = _first_section(stats, ("STATS",))
    if not section:
        return

    # Cerca la stringa lunga "MM ID0" (o varianti)
    mm_text: str = ""
    for key, value in section.items():
        if isinstance(key, str) and key.startswith("MM ID") and isinstance(value, str):
            mm_text = value
            break
    if not mm_text:
        return

    fields = _parse_bracketed_fields(mm_text)

    # ---- Temperature ----
    if (tmax := _opt_float(fields.get("TMax"))) is not None:
        sample.temp_chip_c = tmax
    if (tavg := _opt_float(fields.get("TAvg"))) is not None:
        sample.temp_avg_c = tavg

    # ITemp/OTemp: il sensore restituisce -273 se non presente
    if (itemp := _opt_float(fields.get("ITemp"))) is not None and itemp > -200:
        sample.temp_inlet_c = itemp
    if (otemp := _opt_float(fields.get("OTemp"))) is not None and otemp > -200:
        sample.temp_outlet_c = otemp
        # The Nano3s has no VR sensor: we use OTemp as a secondary
        # thermal proxy ("air outlet temp") in the VR field for UI
        # consistency. If a future Avalon firmware exposes a real Tvr,
        # we overwrite it.
        if sample.temp_vr_c is None:
            sample.temp_vr_c = otemp

    # ---- Ventole ----
    fans: dict[str, int] = {}
    for k, v in fields.items():
        if k.startswith("Fan") and k != "FanR" and (rpm := _opt_int(v)) is not None:
            fans[k.lower()] = rpm
    if fans:
        sample.fans_extra = fans
        sample.fan_rpm = int(sum(fans.values()) / len(fans))
    if (fanr := fields.get("FanR")) is not None:
        # Formato "55%"
        if isinstance(fanr, str) and fanr.endswith("%"):
            try:
                sample.fan_pct = float(fanr[:-1])
            except ValueError:
                pass
        else:
            sample.fan_pct = _opt_float(fanr)

    # ---- Frequency / hashrate from MM (fresher than the summary) ----
    if (freq := _opt_float(fields.get("Freq"))) is not None:
        sample.frequency_mhz = freq
    # GHSavg is in GH/s, we convert to TH/s. Prefer `GHSavg` (real,
    # computed from the valid nonces produced since startup) over
    # `GHSspd` (theoretical setpoint based on configured frequency):
    # only GHSavg matches what the pool actually "sees" from shares,
    # and it includes the effect of HW errors and thermal throttling.
    # `GHSspd` stays as a fallback for compatibility with any Avalon
    # firmware that doesn't expose GHSavg.
    ghs = _opt_float(fields.get("GHSavg")) or _opt_float(fields.get("GHSspd"))
    if ghs is not None:
        # Only overwrite if the summary didn't yield a reasonable value
        if sample.hashrate_ths is None or sample.hashrate_ths <= 0:
            sample.hashrate_ths = round(ghs / 1000.0, 4)

    # ---- Potenza ----
    # MPO = Measured Power Output, directly in watts. It is the "real"
    # field for power draw on the Nano3s (not PS[], which has
    # inconsistent units).
    if (mpo := _opt_float(fields.get("MPO"))) is not None:
        sample.power_w = round(mpo, 1)

    # ---- Voltaggio core (media PVT_V0, in centivolt → mV) ----
    pvt_v = fields.get("PVT_V0")
    if isinstance(pvt_v, str) and pvt_v.strip():
        vals = [v for v in (_opt_float(x) for x in pvt_v.split()) if v is not None]
        if vals:
            avg_cv = sum(vals) / len(vals)
            # The Nano3s values are in centivolts × 100 (e.g. 321 = 3.21V).
            # Convertiamo in mV: 3.21V × 1000 = 3210mV → centivolt × 10
            sample.voltage_mv = int(round(avg_cv * 10))
            sample.asic_count = len(vals)

    # asic_count: also take from TA[] (number of ASICs alive) if PVT_V0 wasn't present
    if sample.asic_count is None:
        ta = _opt_int(fields.get("TA"))
        if ta:
            sample.asic_count = ta


def _enrich_from_pools(sample: MinerSample, pools: dict[str, Any]) -> None:
    """Populate ``sample.pools`` and the legacy ``pool_url``/``worker``.

    Avalon firmware speaks the cgminer ``pools`` dialect, so the shared
    parser in ``base.py`` handles the per-entry shape; we just sort and
    pick the "chosen" entry to fill the legacy scalars (still read by
    the dashboard cards, the DB and the alerts pipeline).
    """
    plist = pools.get("POOLS")
    if not isinstance(plist, list):
        return
    entries = [_parse_cgminer_pool_entry(p) for p in plist if isinstance(p, dict)]
    entries.sort(
        key=lambda p: (p.priority if p.priority is not None else 999, p.url or "")
    )
    sample.pools = entries
    chosen = None
    for p in entries:
        if p.active:
            chosen = p
            break
    if chosen is None:
        for p in entries:
            if p.status == "alive":
                chosen = p
                break
    if chosen is None and entries:
        chosen = entries[0]
    if chosen is not None:
        sample.pool_url = chosen.url
        sample.worker = chosen.user


# Parser for strings like "Foo[bar] Baz[qux]". Handles values with
# inner spaces (e.g. "PS[0 0 27458 4 0 3990 130]") and with
# commas/percent signs.
_BRACKET_RE = re.compile(r"([A-Za-z][A-Za-z0-9_]*)\s*\[([^\[\]]*)\]")


def _parse_bracketed_fields(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in _BRACKET_RE.finditer(text):
        key = m.group(1)
        value = m.group(2).strip()
        out[key] = value
    return out


def _format_mac(raw: str) -> str:
    raw = raw.strip().upper().replace("-", "").replace(":", "")
    if len(raw) != 12:
        return raw
    return ":".join(raw[i : i + 2] for i in range(0, 12, 2))


def _opt_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        # Keep only the first word if there are several (e.g. "55%")
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
