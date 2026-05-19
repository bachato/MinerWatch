# SPDX-License-Identifier: AGPL-3.0-only
"""Driver for the NerdOctaxe (NerdOCTAXE-Plus / NerdOCTAXE-Gamma).

The NerdOctaxe is an 8-ASIC home-miner from the Bitaxe family. The hardware
is from Patsch91 (`NerdOCTAXE-Plus` and `NerdOCTAXE-Gamma` repos); the
firmware is `shufps/ESP-Miner-NerdQAxePlus`, a fork of AxeOS adapted for
multi-chip boards.

The REST surface is *almost* the same as Bitaxe — same `/api/system/info`,
same PATCH-to-`/api/system` for control — but with extras that matter:

  - ``currentA``                PSU draw in Amps (float)
  - ``fanrpm2`` / ``fanspeed2`` second physical fan (NerdOctaxe has two)
  - ``duplicateHWNonces``       aggregate HW-error counter (no per-chip
                                error array exists in this firmware)
  - ``fallbackStratumURL`` /    secondary pool (the device supports a
    ``fallbackStratumPort`` /   primary + fallback pool config)
    ``fallbackStratumUser``
  - ``stratum.activePoolMode``  nested object that tells which pool is
    / ``stratum.usingFallback`` currently mining

So we inherit from BitaxeDriver to reuse the HTTP client, the
control endpoints (PATCH/restart/fan/freq/voltage), and the base
parser, then layer the NerdOctaxe-specific fields on top.

Reference: ``main/http_server/handler_system.cpp`` in
https://github.com/shufps/ESP-Miner-NerdQAxePlus
"""
from __future__ import annotations

from typing import Any

from .base import PoolSnapshot
from .bitaxe import BitaxeDriver, _opt_float, _opt_int


class NerdOctaxeDriver(BitaxeDriver):
    """NerdOctaxe (8-ASIC, dual-fan, dual-pool) driver.

    All control endpoints (`set_fan_speed`, `set_frequency`,
    `set_voltage`, `restart`) are inherited unchanged from
    :class:`BitaxeDriver`: the firmware accepts the same PATCH payload.
    Only the read path differs.
    """

    family = "nerdoctaxe"
    # Same defaults as Bitaxe; firmware is served on port 80.
    # Control capabilities mirror the parent (we choose to keep
    # pool-config writes out of scope for now — see HANDOFF/PR notes).

    def _parse(self, data: dict[str, Any]):
        # Start from the Bitaxe parser so we inherit the established
        # field mappings (hashrate, temp, accepted/rejected, best
        # difficulty, etc.). Then patch in the NerdOctaxe extras.
        sample = super()._parse(data)
        # Override the family — BitaxeDriver._parse() stamps "bitaxe".
        sample.family = self.family

        # ---- PSU draw (Amps) ---------------------------------------
        # firmware emits both `current` (mA, int) and `currentA` (A, float).
        # Prefer the A-scaled field; fall back to mA / 1000 if missing.
        current_a = _opt_float(data.get("currentA"))
        if current_a is None:
            current_ma = _opt_float(data.get("current"))
            if current_ma is not None:
                current_a = round(current_ma / 1000.0, 3)
        sample.current_a = current_a

        # ---- Second fan --------------------------------------------
        # `fanrpm2` is 0 when getNumFans() == 1; treat that as "no
        # second fan" rather than "fan stopped". `fanCount` is the
        # authoritative flag for whether a real second fan exists.
        fan_count = _opt_int(data.get("fanCount"))
        fan_rpm_2 = _opt_int(data.get("fanrpm2"))
        fan_pct_2 = _opt_float(data.get("fanspeed2"))
        # Only expose the second-fan readings if the firmware reports
        # an actual second fan. Otherwise we'd render a "Fan 2: 0 rpm"
        # tile that's just visual noise.
        if fan_count and fan_count > 1:
            sample.fan_rpm_2 = fan_rpm_2
            sample.fan_pct_2 = fan_pct_2

        # ---- Hardware errors ---------------------------------------
        # The closest analogue to "chip error rate" in the AxeOS-fork
        # firmware. Aggregate, not per-chip.
        sample.hw_errors = _opt_int(data.get("duplicateHWNonces"))

        # ---- Dual-pool config (read-only) --------------------------
        fb_url = data.get("fallbackStratumURL") or ""
        fb_port = data.get("fallbackStratumPort")
        fb_user = data.get("fallbackStratumUser") or ""
        if fb_url:
            if fb_port:
                sample.pool_url_fallback = f"{fb_url}:{fb_port}"
            else:
                sample.pool_url_fallback = fb_url
        # `worker_fallback` mirrors `worker` (which BitaxeDriver fills
        # from `stratumUser`) — empty string means "not configured".
        sample.worker_fallback = fb_user or None

        # Which pool is currently in use. The firmware emits a nested
        # `stratum` object with `activePoolMode` ("primary"/"fallback")
        # plus a `usingFallback` boolean in single-fallback mode and
        # a `pools[]` array (entry 0 = primary, 1 = fallback) where
        # `connected: true` marks the one actively mining. We prefer
        # the explicit strings when present, then fall back to the
        # boolean, then to inspecting the pools array.
        stratum = data.get("stratum") if isinstance(data.get("stratum"), dict) else None
        if stratum:
            mode = stratum.get("activePoolMode")
            if isinstance(mode, str) and mode:
                # Firmware uses lowercase identifiers; normalise here so
                # the frontend can compare against {"primary","fallback"}.
                sample.pool_active = mode.lower()
            elif isinstance(stratum.get("usingFallback"), bool):
                sample.pool_active = (
                    "fallback" if stratum["usingFallback"] else "primary"
                )
            else:
                pools = stratum.get("pools")
                if isinstance(pools, list) and pools:
                    # If the array has 2 entries (dual mode), pick the
                    # connected one; with 1 entry we can't tell which
                    # slot it is without `usingFallback`, so leave None.
                    if len(pools) >= 2:
                        if isinstance(pools[1], dict) and pools[1].get("connected"):
                            sample.pool_active = "fallback"
                        elif isinstance(pools[0], dict) and pools[0].get("connected"):
                            sample.pool_active = "primary"

        # ---- Structured pools list ---------------------------------
        # The Bitaxe parent already filled ``sample.pools`` with a
        # single entry for the primary slot, and set ``active=True``
        # on it. On NerdOctaxe that flag is wrong whenever the miner
        # is currently using the fallback slot, AND we have a second
        # row to add. Rebuild the list from scratch here using the
        # scalar fields the parent populated plus the fallback fields
        # we just parsed.
        #
        # ``accepted`` / ``rejected`` are *fleet totals* on AxeOS-fork
        # firmware (one global counter, not per-slot), so we attribute
        # them to whichever slot is currently active and leave the
        # other slot's counters as None. That's the honest answer: the
        # firmware doesn't break shares down per pool slot, and
        # zero-ing the inactive row would falsely imply "the fallback
        # pool has rejected 0 shares" when in reality we just don't
        # know.
        pools_list: list[PoolSnapshot] = []
        if sample.pool_url:
            pools_list.append(
                PoolSnapshot(
                    url=sample.pool_url,
                    user=sample.worker,
                    accepted=(
                        sample.accepted
                        if sample.pool_active != "fallback"
                        else None
                    ),
                    rejected=(
                        sample.rejected
                        if sample.pool_active != "fallback"
                        else None
                    ),
                    active=(sample.pool_active != "fallback"),
                    slot="primary",
                )
            )
        if sample.pool_url_fallback:
            pools_list.append(
                PoolSnapshot(
                    url=sample.pool_url_fallback,
                    user=sample.worker_fallback,
                    accepted=(
                        sample.accepted
                        if sample.pool_active == "fallback"
                        else None
                    ),
                    rejected=(
                        sample.rejected
                        if sample.pool_active == "fallback"
                        else None
                    ),
                    active=(sample.pool_active == "fallback"),
                    slot="fallback",
                )
            )
        sample.pools = pools_list
        return sample
