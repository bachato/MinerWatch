# SPDX-License-Identifier: AGPL-3.0-only
"""Miner drivers.

Every driver inherits from :class:`base.MinerDriver` and implements
at least ``poll()``. The registry maps the family name (``bitaxe``,
``nerdoctaxe``, ``canaan``, ``braiins``, ``luxos``) to the driver class.
"""
from __future__ import annotations

from typing import Type

from .base import MinerDriver, MinerSample
from .bitaxe import BitaxeDriver
from .nerdoctaxe import NerdOctaxeDriver
from .canaan import CanaanDriver
from .braiins import BraiinsDriver
from .luxos import LuxosDriver

DRIVERS: dict[str, Type[MinerDriver]] = {
    "bitaxe": BitaxeDriver,
    # NerdOctaxe shares the Bitaxe REST surface but adds dual-fan,
    # dual-pool and PSU-current readings — see nerdoctaxe.py.
    "nerdoctaxe": NerdOctaxeDriver,
    "canaan": CanaanDriver,
    "braiins": BraiinsDriver,
    "luxos": LuxosDriver,
}


def get_driver(family: str) -> Type[MinerDriver]:
    family = (family or "").lower()
    if family not in DRIVERS:
        raise ValueError(f"Unknown miner family: {family!r}")
    return DRIVERS[family]


def driver_for_record(record: dict) -> MinerDriver:
    cls = get_driver(record["family"])
    return cls(
        host=record["host"],
        port=record.get("port"),
        timeout=record.get("timeout", 4),
    )


__all__ = [
    "MinerDriver",
    "MinerSample",
    "BitaxeDriver",
    "NerdOctaxeDriver",
    "CanaanDriver",
    "BraiinsDriver",
    "LuxosDriver",
    "DRIVERS",
    "get_driver",
    "driver_for_record",
]
