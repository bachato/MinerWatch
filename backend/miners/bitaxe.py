# SPDX-License-Identifier: AGPL-3.0-only
"""Driver per Bitaxe e NerdQAxe.

Espongono una API REST/JSON molto pulita su porta 80:
- ``GET  /api/system/info``         current metrics + identity
- ``PATCH /api/system``              imposta frequency/coreVoltage/fanspeed/autofanspeed
- ``POST /api/system/restart``      restart
- ``POST /api/system/OTA``          (firmware OTA, non usato qui)

Documentazione di riferimento: https://github.com/skot/bitaxe
"""
from __future__ import annotations

from typing import Any

import httpx

from .base import (
    MinerDriver,
    MinerSample,
    PoolSnapshot,
    parse_si_difficulty as _parse_si_difficulty,
)


class BitaxeDriver(MinerDriver):
    family = "bitaxe"
    DEFAULT_PORT = 80
    can_set_fan = True
    can_set_frequency = True
    can_set_voltage = True
    can_restart = True

    def _base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    async def poll(self) -> MinerSample:
        url = f"{self._base_url()}/api/system/info"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as cli:
                resp = await cli.get(url)
                resp.raise_for_status()
                data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            return MinerSample(
                family=self.family,
                host=self.host,
                online=False,
                error=str(exc),
            )

        return self._parse(data)

    @staticmethod
    def _ths(hashrate_value: Any) -> float | None:
        """Converte l'hashrate Bitaxe (di solito GH/s in float) in TH/s."""
        if hashrate_value is None:
            return None
        try:
            ghs = float(hashrate_value)
        except (TypeError, ValueError):
            return None
        return round(ghs / 1000.0, 4)

    def _parse(self, data: dict[str, Any]) -> MinerSample:
        hashrate_ths = self._ths(data.get("hashRate"))
        power_w = _opt_float(data.get("power"))

        eff = None
        if hashrate_ths and power_w and hashrate_ths > 0:
            eff = round(power_w / hashrate_ths, 2)

        # Bitaxe exposes temp (chip) and vrTemp (voltage regulator)
        temp_chip = _opt_float(data.get("temp"))
        temp_vr = _opt_float(data.get("vrTemp"))

        # Frequenza in MHz, voltage in mV
        freq_mhz = _opt_float(data.get("frequency"))
        voltage_mv = _opt_float(data.get("coreVoltageActual") or data.get("coreVoltage"))

        fan_rpm = _opt_int(data.get("fanrpm"))
        fan_pct = _opt_float(data.get("fanspeed"))

        accepted = _opt_int(data.get("sharesAccepted"))
        rejected = _opt_int(data.get("sharesRejected"))
        # AxeOS exposes both:
        # - bestSessionDiff: best share since the last reboot
        # - bestDiff:        all-time best, persisted in NVS flash
        # Modern firmwares (2.x+) ship them as SI strings ("4.29G",
        # "2.15M"); older firmwares as raw numbers. We use the SI parser
        # so both formats survive. We populate `best_difficulty` with
        # the *session* value (it's what other drivers also expose);
        # the all-time hint is exposed via `raw["bestDiff"]` and is
        # tracked DB-side in `best_records`.
        # `dict.get(key, default)` only uses the default when the key is
        # missing — not when it's present with a falsy value (e.g. None
        # or ""). Prefer session, but fall back to all-time when the
        # session field is unavailable in either way.
        _bsd = data.get("bestSessionDiff")
        _bd = data.get("bestDiff")
        best_diff_session = _parse_si_difficulty(_bsd if _bsd not in (None, "") else _bd)
        # `bestDiff` is the firmware's NVS-persisted all-time record.
        # We thread it through as `best_difficulty_alltime` so MinerWatch
        # can seed its own DB record on first contact (or after a wipe)
        # without waiting for a brand-new high share to materialise.
        best_diff_alltime = _parse_si_difficulty(_bd)

        # AxeOS reports the current Bitcoin network difficulty as seen
        # via stratum. Most modern firmwares expose ``networkDifficulty``
        # as a numeric value already in "raw" form (no SI suffix). If
        # for some reason it comes back as an SI string ("125.5T"), the
        # SI parser handles both. Used by MinerWatch to detect a "block
        # found" event (share difficulty >= network difficulty).
        network_diff = _parse_si_difficulty(data.get("networkDifficulty"))

        pool_url = data.get("stratumURL") or data.get("stratumUrl")
        if pool_url and data.get("stratumPort"):
            pool_url = f"{pool_url}:{data['stratumPort']}"
        worker = data.get("stratumUser")

        sample = MinerSample(
            family=self.family,
            host=self.host,
            online=True,
            mac=(data.get("macAddr") or data.get("macAddress") or "").upper() or None,
            model=data.get("ASICModel") or data.get("boardVersion"),
            hostname=data.get("hostname"),
            firmware_version=data.get("version") or data.get("firmwareVersion"),
            hashrate_ths=hashrate_ths,
            power_w=power_w,
            efficiency_w_per_ths=eff,
            temp_chip_c=temp_chip,
            temp_vr_c=temp_vr,
            fan_rpm=fan_rpm,
            fan_pct=fan_pct,
            frequency_mhz=freq_mhz,
            voltage_mv=voltage_mv,
            asic_count=_opt_int(data.get("asicCount")),
            uptime_s=_opt_int(data.get("uptimeSeconds")),
            accepted=accepted,
            rejected=rejected,
            best_difficulty=best_diff_session,
            best_difficulty_alltime=best_diff_alltime,
            network_difficulty=network_diff,
            pool_url=pool_url,
            worker=worker,
            raw=data,
        )

        # Synthesise the structured pools list. AxeOS only exposes one
        # stratum slot (the dual-pool fields are NerdOctaxe-specific —
        # see :class:`NerdOctaxeDriver`). ``status`` is left None
        # because AxeOS has no equivalent of cgminer's Alive/Dead flag:
        # if the miner answered ``/api/system/info`` and we got here,
        # the pool *for this miner* is at least reachable, but the
        # frontend decides how to render that (typically "—" or an
        # implicit health pill derived from accepted vs rejected). The
        # share counters are fleet-totals — AxeOS doesn't break them
        # down per slot, so on a Bitaxe accepted/rejected on the only
        # pool row are simply the miner's totals.
        if pool_url:
            sample.pools = [
                PoolSnapshot(
                    url=pool_url,
                    user=worker,
                    accepted=accepted,
                    rejected=rejected,
                    active=True,
                    slot="primary",
                )
            ]
        return sample

    # ---- Controlli ----

    async def _patch_system(self, payload: dict[str, Any]) -> bool:
        url = f"{self._base_url()}/api/system"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as cli:
                resp = await cli.patch(url, json=payload)
                resp.raise_for_status()
        except httpx.HTTPError:
            return False
        return True

    async def set_fan_speed(self, percent: int) -> bool:
        percent = max(0, min(100, int(percent)))
        # autofanspeed=0 disattiva l'autofan, fanspeed imposta il duty.
        return await self._patch_system({"autofanspeed": 0, "fanspeed": percent})

    async def set_auto_fan(self, enabled: bool) -> bool:
        return await self._patch_system({"autofanspeed": 1 if enabled else 0})

    async def set_frequency(self, mhz: int) -> bool:
        return await self._patch_system({"frequency": int(mhz)})

    async def set_voltage(self, millivolts: int) -> bool:
        return await self._patch_system({"coreVoltage": int(millivolts)})

    async def restart(self) -> bool:
        url = f"{self._base_url()}/api/system/restart"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as cli:
                resp = await cli.post(url)
                resp.raise_for_status()
        except httpx.HTTPError:
            return False
        return True


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
