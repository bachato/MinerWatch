# SPDX-License-Identifier: AGPL-3.0-only
"""Auto-discovery of miners on the local network.

Scans the subnet (configurable CIDR) probing ports 80 and 4028.
For every IP that answers we try the supported drivers to determine
the family (Bitaxe/NerdQAxe via REST, Avalon/Braiins via cgminer-API).

How it works:
- Non-blocking TCP socket with a short timeout (~0.4s)
- For each candidate, poll with the matching driver
- On a valid reply the miner is UPSERTed in the DB using the MAC as
  the stable key.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from typing import Iterable

from .config import get_config
from . import db
from .miners import BitaxeDriver, BraiinsDriver, CanaanDriver, LuxosDriver

log = logging.getLogger("minerwatch.discovery")

PORT_BITAXE = 80
PORT_CGMINER = 4028


async def _port_open(host: str, port: int, timeout: float) -> bool:
    try:
        fut = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return True
    except (OSError, asyncio.TimeoutError):
        return False


def _local_cidr() -> str | None:
    """Guess the host's subnet, or ``None`` if it can't be determined.

    The trick: opening a UDP "connection" towards a public address
    (8.8.8.8:53) doesn't send anything on the wire, but it forces the
    kernel to pick the outbound interface — whose IP we then read with
    ``getsockname()``. From that we derive the local /24.

    Returns ``None`` instead of guessing on failure: a stale fallback
    like 192.168.1.0/24 is silently wrong on every other subnet
    (192.168.0.x, 10.x, 192.168.178.x …) and just makes auto-discovery
    look broken. The caller logs a clear message and points at the
    Settings page where the user can set ``scan_cidr`` manually.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 53))
            local_ip = s.getsockname()[0]
        net = ipaddress.IPv4Network(f"{local_ip}/24", strict=False)
        return str(net)
    except OSError:
        return None


def _enumerate_hosts(cidr: str) -> Iterable[str]:
    network = ipaddress.IPv4Network(cidr, strict=False)
    for host in network.hosts():
        yield str(host)


async def _identify_bitaxe(host: str) -> dict | None:
    drv = BitaxeDriver(host=host, timeout=2)
    sample = await drv.poll()
    if not sample.online:
        return None
    return {
        "family": "bitaxe",
        "host": host,
        "port": PORT_BITAXE,
        "mac": sample.mac,
        "model": sample.model or "Bitaxe",
        "name": sample.hostname or sample.model or f"Bitaxe {host}",
    }


async def _identify_cgminer(host: str) -> dict | None:
    """Tell LuxOS / Braiins / Canaan apart on port 4028.

    All three speak a cgminer-compatible API, so the only way to know
    which firmware we're talking to is to call ``version`` and inspect
    the fingerprint. Order matters: we probe LuxOS first because its
    fingerprint is the most distinctive (``LUXminer``); Braiins second
    (``BOSminer``/``BOSminer+``); Canaan/Avalon last as the fallback
    since its ``version`` reply doesn't carry a unique marker.
    """
    # Try LuxOS first — fingerprint is unmistakable (the firmware_version
    # string starts with "LUXminer x.y.z-<git>"). The LuxosDriver is the
    # most permissive parser, so a non-LuxOS miner that happens to
    # answer here will just not match the marker below.
    luxos = LuxosDriver(host=host, timeout=2)
    sample = await luxos.poll()
    if sample.online:
        v = (sample.firmware_version or "").lower()
        m = (sample.model or "").lower()
        if "luxminer" in v or "luxos" in v or "luxor" in v or "lux" in m:
            return {
                "family": "luxos",
                "host": host,
                "port": PORT_CGMINER,
                "mac": sample.mac,
                "model": sample.model or "LuxOS",
                "name": sample.model or f"LuxOS {host}",
            }

    # Try Braiins (BOSminer answers well-formed JSON)
    braiins = BraiinsDriver(host=host, timeout=2)
    sample = await braiins.poll()
    if sample.online:
        # BOSminer answers `version` with BOSminer / BOSminer+ fields
        v = (sample.firmware_version or "").lower()
        m = (sample.model or "").lower()
        if "bos" in v or "braiins" in v or "bmm" in m or "braiins" in m:
            return {
                "family": "braiins",
                "host": host,
                "port": PORT_CGMINER,
                "mac": sample.mac,
                "model": sample.model or "Braiins",
                "name": sample.model or f"Braiins {host}",
            }

    # Fallback: assume Avalon. Its `version` reply doesn't have a
    # unique marker, so it's the catch-all for "cgminer-API on 4028
    # that didn't identify as anything more specific".
    canaan = CanaanDriver(host=host, timeout=2)
    sample = await canaan.poll()
    if sample.online:
        return {
            "family": "canaan",
            "host": host,
            "port": PORT_CGMINER,
            "mac": sample.mac,
            "model": sample.model or "Avalon",
            "name": sample.model or f"Avalon {host}",
        }
    return None


async def scan_network(cidr: str | None = None) -> list[dict]:
    cfg = get_config()
    if not cidr:
        cidr = cfg.network.scan_cidr
    if cidr in (None, "", "auto"):
        cidr = _local_cidr()
        if cidr is None:
            log.warning(
                "Discovery: could not auto-detect the host's subnet "
                "(no network interface or no default route). "
                "Set network.scan_cidr from the Settings page (e.g. "
                "192.168.0.0/24 or 10.0.0.0/24) and retry."
            )
            return []
    log.info("Discovery: scanning %s", cidr)

    hosts = list(_enumerate_hosts(cidr))
    timeout = cfg.network.scan_timeout

    # Step 1: find which hosts have at least one open port
    sem = asyncio.Semaphore(64)

    async def probe(host: str) -> tuple[str, list[int]]:
        async with sem:
            results = await asyncio.gather(
                _port_open(host, PORT_BITAXE, timeout),
                _port_open(host, PORT_CGMINER, timeout),
            )
        open_ports = [
            p for p, is_open in zip([PORT_BITAXE, PORT_CGMINER], results) if is_open
        ]
        return host, open_ports

    probes = await asyncio.gather(*(probe(h) for h in hosts))
    candidates = [(h, ports) for h, ports in probes if ports]
    log.info("Discovery: %d candidate host(s)", len(candidates))

    # Step 2: identify the family with the matching driver
    found: list[dict] = []
    for host, ports in candidates:
        info = None
        if PORT_BITAXE in ports:
            info = await _identify_bitaxe(host)
        if not info and PORT_CGMINER in ports:
            info = await _identify_cgminer(host)
        if info:
            found.append(info)

    log.info("Discovery: identified %d miner(s)", len(found))
    return found


async def discover_and_register() -> list[dict]:
    """Run the scan and UPSERT the miners found into the DB."""
    found = await scan_network()
    for info in found:
        await db.upsert_miner(info)
    return found
