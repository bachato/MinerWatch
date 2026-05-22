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

    async def fetch_asic_info(self) -> dict[str, Any]:
        """Fetch ``/api/system/asic`` — the static ASIC / board identity.

        This endpoint carries ``deviceModel`` (the human-readable model
        name: "Gamma", "Supra", "SupraHex", "NerdQAxe++"…), along with
        ``asicCount`` and the frequency/voltage option lists. It is
        separate from ``/api/system/info`` (live metrics) and is the
        authoritative source for *which* device this is — see
        https://osmu.wiki/bitaxe/api.

        Best-effort: returns ``{}`` on any error, or on firmware too old
        to expose the endpoint, so callers can fall back to ``ASICModel``.
        """
        url = f"{self._base_url()}/api/system/asic"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as cli:
                resp = await cli.get(url)
                resp.raise_for_status()
                data = resp.json()
        except (httpx.HTTPError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

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

        # Bitaxe exposes temp (chip sensor 1) and vrTemp (voltage
        # regulator). Multi-ASIC boards like the SupraHex (6× BM1368) add
        # a second on-board chip sensor as temp2; single-ASIC boards omit
        # it (or report the firmware's -1 "no sensor" sentinel). We treat
        # any non-positive reading as absent so the sentinel never poisons
        # the max() below or surfaces as a bogus 0 °C row.
        temp_s1 = _valid_temp(_opt_float(data.get("temp")))
        temp_s2 = _valid_temp(_opt_float(data.get("temp2")))
        # ``temp_chip_c`` is the hottest chip sensor, matching every other
        # multi-sensor driver (luxos/braiins/canaan all use max()). This is
        # the value the overheat alert and the auto-fan PID read, so on a
        # two-sensor board it must follow the hotter cluster — not sensor 1,
        # which on the SupraHex can read ~12 °C cooler than sensor 2.
        _chip_temps = [t for t in (temp_s1, temp_s2) if t is not None]
        temp_chip = round(max(_chip_temps), 1) if _chip_temps else None
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

        # Fallback (secondary) stratum. Modern AxeOS / ESP-Miner exposes a
        # fallback pool on *all* Bitaxe-class boards — not just the
        # NerdOctaxe — via ``fallbackStratumURL`` / ``fallbackStratumPort``
        # / ``fallbackStratumUser``, plus ``isUsingFallbackStratum`` (0/1)
        # which tells us which slot is *currently* mining.
        fallback_url = data.get("fallbackStratumURL") or data.get("fallbackStratumUrl")
        if fallback_url and data.get("fallbackStratumPort"):
            fallback_url = f"{fallback_url}:{data['fallbackStratumPort']}"
        worker_fallback = data.get("fallbackStratumUser") or None
        # Only honour the "using fallback" flag when a fallback endpoint is
        # actually configured. Guards against firmware that reports the
        # flag set with no fallback URL, which would otherwise leave the
        # miner with no slot marked active at all.
        using_fallback = _coerce_flag(data.get("isUsingFallbackStratum")) and bool(
            fallback_url
        )

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
            temp_chip_2_c=temp_s2,
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
            pool_url_fallback=fallback_url or None,
            worker_fallback=worker_fallback,
            pool_active=(
                ("fallback" if using_fallback else "primary")
                if (pool_url or fallback_url)
                else None
            ),
            raw=data,
        )

        # Synthesise the structured pools list. AxeOS exposes a primary
        # stratum slot and (on modern firmware) a fallback slot; we emit
        # one ``PoolSnapshot`` per configured slot. ``active`` follows the
        # firmware's ``isUsingFallbackStratum`` flag so the Pools page
        # marks whichever pool is *actually* mining — not always the
        # primary. ``status`` is left None because AxeOS has no equivalent
        # of cgminer's Alive/Dead flag: if the miner answered
        # ``/api/system/info`` and we got here, the pool is at least
        # reachable, and the frontend renders an implicit health pill from
        # accepted vs rejected.
        #
        # The share counters (``sharesAccepted`` / ``sharesRejected``) are
        # miner-level fleet-totals — AxeOS doesn't break them down per
        # slot — so we attribute them to whichever slot is currently
        # active and leave the idle slot's counters None. Zero-ing the
        # idle slot would falsely imply "0 rejected" when the firmware
        # simply doesn't report a per-slot breakdown.
        #
        # ``responseTime`` is AxeOS's stratum round-trip latency in ms
        # (the "ping" shown in the AxeOS web UI). It's a single
        # miner-level value — attributed here to the active slot only.
        # The NerdQAxe fork reports None here and uses per-pool
        # ``pingRtt`` instead; :class:`NerdOctaxeDriver` overrides this.
        ping_ms = _opt_float(data.get("responseTime"))
        pools: list[PoolSnapshot] = []
        if pool_url:
            primary_active = not using_fallback
            pools.append(
                PoolSnapshot(
                    url=pool_url,
                    user=worker,
                    accepted=accepted if primary_active else None,
                    rejected=rejected if primary_active else None,
                    active=primary_active,
                    slot="primary",
                    ping_ms=ping_ms if primary_active else None,
                )
            )
        if fallback_url:
            pools.append(
                PoolSnapshot(
                    url=fallback_url,
                    user=worker_fallback,
                    accepted=accepted if using_fallback else None,
                    rejected=rejected if using_fallback else None,
                    active=using_fallback,
                    slot="fallback",
                    ping_ms=ping_ms if using_fallback else None,
                )
            )
        sample.pools = pools
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


def _valid_temp(value: float | None) -> float | None:
    """Drop the firmware's "sensor absent" sentinel.

    AxeOS reports an unpopulated temperature sensor as ``-1`` (seen on
    ``boardTemp`` and on the second chip sensor of single-sensor boards).
    A genuine chip reading is always a positive Celsius value, so we treat
    anything ``<= 0`` as missing — this keeps the sentinel out of the
    ``max()`` aggregation and prevents a phantom "0 °C" row in the UI.
    """
    if value is None or value <= 0:
        return None
    return value


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


def _coerce_flag(value: Any) -> bool:
    """Interpret a firmware boolean-ish field as a Python bool.

    AxeOS reports ``isUsingFallbackStratum`` as an int (0/1) on most
    builds, but we tolerate bool and string forms ("0"/"1"/"true"/…)
    so the parser survives firmware quirks across versions.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return False
