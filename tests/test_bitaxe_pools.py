# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for BitaxeDriver pool-slot parsing, focused on fallback handling.

Regression coverage for the bug where a miner running on its *fallback*
stratum still showed the *primary* pool as "Active" in the Pools tab.
The root cause was ``BitaxeDriver._parse()`` emitting a single, always-
active primary ``PoolSnapshot`` and ignoring ``isUsingFallbackStratum``
plus the ``fallbackStratum*`` fields.

Runs under pytest, or standalone: ``python tests/test_bitaxe_pools.py``.
"""
from __future__ import annotations

import pathlib
import sys

# Make the repo root importable whether invoked via pytest or directly.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from backend.miners.bitaxe import BitaxeDriver  # noqa: E402


def _sample_info(**overrides):
    """A minimal /api/system/info payload shaped like the bug report's
    screenshot (BM1370 Bitaxe with a configured fallback stratum)."""
    data = {
        "hashRate": 1200.5,
        "power": 18.0,
        "temp": 55.0,
        "frequency": 870,
        "coreVoltageActual": 1269,
        "ASICModel": "BM1370",
        "hostname": "bitaxe",
        "version": "v2.5.0",
        "sharesAccepted": 13094,
        "sharesRejected": 0,
        "uptimeSeconds": 66739,
        "responseTime": 12.0,
        "stratumURL": "192.168.1.100",
        "stratumPort": 2018,
        "stratumUser": "bc1qprimary.worker",
        "fallbackStratumURL": "192.168.1.50",
        "fallbackStratumPort": 4567,
        "fallbackStratumUser": "bc1qfallback.worker",
        "isUsingFallbackStratum": 1,
    }
    data.update(overrides)
    return data


def _parse(**overrides):
    return BitaxeDriver("10.0.0.1")._parse(_sample_info(**overrides))


def _by_slot(sample, slot):
    matches = [p for p in sample.pools if p.slot == slot]
    assert len(matches) == 1, f"expected exactly one {slot} slot, got {len(matches)}"
    return matches[0]


def test_fallback_active_marks_fallback_as_active():
    """The reported bug: isUsingFallbackStratum=1 must mark the fallback
    slot active and the primary slot inactive."""
    sample = _parse(isUsingFallbackStratum=1)

    assert len(sample.pools) == 2
    primary = _by_slot(sample, "primary")
    fallback = _by_slot(sample, "fallback")

    assert fallback.active is True
    assert primary.active is False
    assert sample.pool_active == "fallback"

    # URLs/users are mapped to the right slot.
    assert primary.url == "192.168.1.100:2018"
    assert fallback.url == "192.168.1.50:4567"
    assert fallback.user == "bc1qfallback.worker"

    # Miner-level counters + ping go to the active (fallback) slot only.
    assert fallback.accepted == 13094
    assert fallback.ping_ms == 12.0
    assert primary.accepted is None
    assert primary.ping_ms is None


def test_primary_active_when_not_using_fallback():
    sample = _parse(isUsingFallbackStratum=0)

    primary = _by_slot(sample, "primary")
    fallback = _by_slot(sample, "fallback")

    assert primary.active is True
    assert fallback.active is False
    assert sample.pool_active == "primary"
    assert primary.accepted == 13094
    assert primary.ping_ms == 12.0
    assert fallback.accepted is None


def test_no_fallback_configured_single_primary_slot():
    sample = _parse(
        fallbackStratumURL="",
        fallbackStratumPort=0,
        fallbackStratumUser="",
        isUsingFallbackStratum=0,
    )

    assert len(sample.pools) == 1
    primary = sample.pools[0]
    assert primary.slot == "primary"
    assert primary.active is True
    assert sample.pool_active == "primary"
    assert sample.pool_url_fallback is None


def test_flag_set_but_no_fallback_url_falls_back_to_primary():
    """Guard: a firmware reporting the flag set with no fallback endpoint
    must not leave the miner with zero active pools."""
    sample = _parse(
        fallbackStratumURL="",
        fallbackStratumPort=0,
        fallbackStratumUser="",
        isUsingFallbackStratum=1,
    )

    assert len(sample.pools) == 1
    primary = sample.pools[0]
    assert primary.active is True
    assert sample.pool_active == "primary"


def test_flag_accepts_bool_and_string_forms():
    for flag in (True, "true", "1", 1):
        sample = _parse(isUsingFallbackStratum=flag)
        assert _by_slot(sample, "fallback").active is True, f"flag={flag!r}"
    for flag in (False, "false", "0", 0):
        sample = _parse(isUsingFallbackStratum=flag)
        assert _by_slot(sample, "primary").active is True, f"flag={flag!r}"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL  {t.__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
