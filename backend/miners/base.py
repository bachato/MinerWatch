# SPDX-License-Identifier: AGPL-3.0-only
"""Common interface shared by all miner drivers.

A driver is a stateless object that knows how to talk to a single
miner via IP. It exposes async methods ``poll()`` (reads current
metrics) and optionally ``set_fan_speed(...)``, ``set_frequency(...)``,
etc.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MinerSample:
    """Snapshot of a miner's current metrics.

    All fields are optional: each driver fills the ones it can read
    from its firmware. Unavailable fields stay ``None`` and appear as
    "—" in the frontend.
    """

    family: str
    host: str
    online: bool = True
    error: str | None = None

    # Identity
    mac: str | None = None
    model: str | None = None
    hostname: str | None = None
    firmware_version: str | None = None

    # Performance
    hashrate_ths: float | None = None  # TH/s
    power_w: float | None = None
    efficiency_w_per_ths: float | None = None

    # Thermal
    temp_chip_c: float | None = None
    temp_vr_c: float | None = None
    temp_outlet_c: float | None = None  # Avalon/Canaan: OTemp
    temp_inlet_c: float | None = None   # Avalon/Canaan: ITemp (often unavailable)
    temp_avg_c: float | None = None     # chip average (TAvg)
    fan_rpm: int | None = None
    fan_pct: float | None = None
    fans_extra: dict[str, int] = field(default_factory=dict)

    # ASIC
    frequency_mhz: float | None = None
    voltage_mv: float | None = None
    asic_count: int | None = None

    # Mining
    uptime_s: int | None = None
    accepted: int | None = None
    rejected: int | None = None
    best_difficulty: float | None = None
    # Optional all-time best, when the firmware persists it across
    # reboots (Bitaxe NVS exposes `bestDiff`). Drivers that don't have
    # persistent storage (cgminer/BOSminer/Avalon `Best Share`) leave
    # this None — MinerWatch then derives all-time from its own DB.
    best_difficulty_alltime: float | None = None
    # Current Bitcoin network difficulty as seen by the miner via
    # stratum. AxeOS exposes this in ``networkDifficulty``. When a share
    # difficulty meets or exceeds this value, the miner has effectively
    # found a block. Drivers that don't surface it leave None; MinerWatch
    # falls back to a periodic fetch from a public block-explorer API.
    network_difficulty: float | None = None
    pool_url: str | None = None
    worker: str | None = None

    # Original payload for debugging / for extracting non-standard fields
    raw: dict[str, Any] | None = None

    def to_db_sample(self) -> dict[str, Any]:
        """Shape suitable for :func:`db.insert_metric`."""
        return {
            "hashrate_ths": self.hashrate_ths,
            "power_w": self.power_w,
            "temp_chip_c": self.temp_chip_c,
            "temp_vr_c": self.temp_vr_c,
            "fan_rpm": self.fan_rpm,
            "fan_pct": self.fan_pct,
            "frequency_mhz": self.frequency_mhz,
            "voltage_mv": self.voltage_mv,
            "uptime_s": self.uptime_s,
            "accepted": self.accepted,
            "rejected": self.rejected,
            "best_difficulty": self.best_difficulty,
            "pool_url": self.pool_url,
            "worker": self.worker,
            "raw": self.raw,
        }


# Suffix → multiplier table for SI-formatted difficulty / share strings.
# AxeOS prints values like "4.29G", "2.15M", "512k"; cgminer/BOSminer
# usually returns raw numbers but some BOS+ builds also use the SI form.
# All keys are lowercase; the parser is case-insensitive.
_SI_SUFFIXES = {
    "": 1.0,
    "k": 1e3,
    "m": 1e6,
    "g": 1e9,
    "t": 1e12,
    "p": 1e15,
    "e": 1e18,
    "z": 1e21,
    "y": 1e24,
}


def parse_si_difficulty(value: Any) -> float | None:
    """Parse a difficulty value as either a number or an SI-suffixed string.

    Returns ``None`` for missing / unparseable input. Examples:

        parse_si_difficulty("4.29G")     -> 4.29e9
        parse_si_difficulty("2.15 M")    -> 2.15e6
        parse_si_difficulty(49224525)    -> 49224525.0
        parse_si_difficulty("0")         -> 0.0
        parse_si_difficulty(None)        -> None
        parse_si_difficulty("")          -> None
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # Last char might be a SI suffix. Tolerate a space between number
    # and suffix and an optional trailing letter (e.g. "B" for "Bytes"
    # in some Antminer builds — irrelevant here but harmless).
    suffix_char = s[-1].lower()
    if suffix_char.isalpha() and suffix_char in _SI_SUFFIXES:
        num_part = s[:-1].strip()
        mult = _SI_SUFFIXES[suffix_char]
    else:
        num_part = s
        mult = 1.0
    try:
        return float(num_part) * mult
    except (TypeError, ValueError):
        return None


class MinerDriver:
    """Base class. Subclasses must override ``DEFAULT_PORT`` and ``poll``."""

    family: str = "generic"
    DEFAULT_PORT: int = 80
    can_set_fan: bool = False
    can_set_frequency: bool = False
    can_set_voltage: bool = False
    can_restart: bool = False

    def __init__(self, host: str, port: int | None = None, timeout: int = 4) -> None:
        self.host = host
        self.port = port or self.DEFAULT_PORT
        self.timeout = timeout

    # ---- API implemented by subclasses ----

    async def poll(self) -> MinerSample:
        raise NotImplementedError

    async def set_fan_speed(self, percent: int) -> bool:  # noqa: D401
        """Set fan speed as a percentage (0-100)."""
        raise NotImplementedError

    async def set_frequency(self, mhz: int) -> bool:
        raise NotImplementedError

    async def set_voltage(self, millivolts: int) -> bool:
        raise NotImplementedError

    async def restart(self) -> bool:
        raise NotImplementedError

    # ---- Helpers ----

    def __repr__(self) -> str:  # pragma: no cover
        return f"{self.__class__.__name__}({self.host}:{self.port})"
