# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for BitaxeDriver ASIC-count parsing.

Regression coverage for the field report: on some firmware/board
combinations AxeOS omits ``asicCount`` from ``/api/system/info`` (the
Gamma exposes it only via the separate ``/api/system/asic`` identity
endpoint), so the Overview's "ASIC COUNT" rendered as "—".

The driver must fall back to the per-ASIC ``hashrateMonitor.asics``
array, whose length is the physical ASIC count: a single-ASIC Gamma
reports one entry, a 6x BM1368 SupraHex reports six. An explicit
``asicCount`` always wins; an absent/empty/malformed monitor block
leaves ``asic_count`` None so the UI keeps showing "—" (never "0").

Runs under pytest, or standalone: ``python tests/test_bitaxe_asic_count.py``.
"""
from __future__ import annotations

import pathlib
import sys

# Make the repo root importable whether invoked via pytest or directly.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from backend.miners.bitaxe import BitaxeDriver  # noqa: E402


def _sample_info(**overrides):
    """A minimal /api/system/info payload. Defaults carry neither
    ``asicCount`` nor ``hashrateMonitor`` so each test opts in to the
    shape it exercises."""
    data = {
        "hashRate": 1200.5,
        "power": 18.0,
        "temp": 55.0,
        "frequency": 870,
        "coreVoltageActual": 1269,
        "ASICModel": "BM1370",
        "hostname": "bitaxe",
        "version": "v2.5.0",
        "uptimeSeconds": 66739,
        "stratumURL": "192.168.1.100",
        "stratumPort": 2018,
        "stratumUser": "bc1qprimary.worker",
    }
    data.update(overrides)
    return data


def _parse(**overrides):
    return BitaxeDriver("10.0.0.1")._parse(_sample_info(**overrides))


# Real-world array shapes, taken from the field report.
_GAMMA_MONITOR = {
    "asics": [
        {
            "total": 1758.3599854,
            "domains": [418.3285828, 446.6766052, 433.791687, 459.5611267],
            "errorCount": 8437,
        }
    ]
}

_SUPRAHEX_MONITOR = {
    "asics": [
        {"total": 733.5756836, "domains": [168.3, 182.1, 201.9, 181.2], "errorCount": 3, "frequency": 590.625},
        {"total": 758.4833374, "domains": [178.6, 199.3, 199.3, 182.1], "errorCount": 412, "frequency": 590.625},
        {"total": 722.4061279, "domains": [173.5, 215.6, 162.3, 170.1], "errorCount": 34, "frequency": 590.625},
        {"total": 734.4319458, "domains": [176.1, 200.2, 183.8, 173.5], "errorCount": 4, "frequency": 590.625},
        {"total": 770.5094604, "domains": [211.3, 179.5, 201.9, 176.1], "errorCount": 2, "frequency": 590.625},
        {"total": 724.9832153, "domains": [197.5, 177.8, 188.1, 161.5], "errorCount": 0, "frequency": 590.625},
    ]
}


def test_gamma_single_asic_from_monitor():
    """Gamma: no asicCount, one entry in hashrateMonitor.asics -> count 1."""
    sample = _parse(hashrateMonitor=_GAMMA_MONITOR)
    assert sample.asic_count == 1


def test_suprahex_six_asics_from_monitor():
    """SupraHex 701 (6x BM1368): six entries -> count 6."""
    sample = _parse(hashrateMonitor=_SUPRAHEX_MONITOR)
    assert sample.asic_count == 6


def test_explicit_asiccount_wins_over_monitor():
    """An explicit asicCount is authoritative and must not be overridden by
    the fallback, even when the array would disagree."""
    sample = _parse(asicCount=1, hashrateMonitor=_SUPRAHEX_MONITOR)
    assert sample.asic_count == 1


def test_explicit_asiccount_without_monitor():
    """Legacy path is unchanged: asicCount present, no monitor block."""
    sample = _parse(asicCount=6)
    assert sample.asic_count == 6


def test_no_count_sources_stays_none():
    """Neither asicCount nor a monitor block -> None (UI shows '—')."""
    sample = _parse()
    assert sample.asic_count is None


def test_empty_asics_array_stays_none():
    """An empty array must not surface as a misleading 0."""
    sample = _parse(hashrateMonitor={"asics": []})
    assert sample.asic_count is None


def test_malformed_monitor_blocks_stay_none():
    """Defensive parsing: non-dict monitor, non-list asics, or a missing
    asics key all degrade to None rather than raising."""
    for bad in (
        {"hashrateMonitor": None},
        {"hashrateMonitor": "nope"},
        {"hashrateMonitor": {}},
        {"hashrateMonitor": {"asics": None}},
        {"hashrateMonitor": {"asics": "nope"}},
        {"hashrateMonitor": {"asics": {}}},
    ):
        sample = _parse(**bad)
        assert sample.asic_count is None, f"input={bad!r}"


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
