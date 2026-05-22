# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for BitaxeDriver chip-temperature parsing on multi-ASIC boards.

Regression coverage for the SupraHex feature request: boards with more
than one ASIC cluster (e.g. the SupraHex 701 — 6× BM1368) expose two
on-board chip sensors as ``temp`` / ``temp2``. The driver must:

  * surface the second sensor as ``temp_chip_2_c`` so the UI can show
    both readings, and
  * set ``temp_chip_c`` to the *hottest* sensor (max), matching every
    other multi-sensor driver, since that field feeds the overheat alert
    and the auto-fan PID. Tracking only sensor 1 would let the hotter
    cluster overheat unnoticed.

Single-sensor boards (the common BM1370 Bitaxe) must be unaffected:
``temp_chip_2_c`` stays None and ``temp_chip_c`` equals ``temp``.

Runs under pytest, or standalone: ``python tests/test_bitaxe_temps.py``.
"""
from __future__ import annotations

import pathlib
import sys

# Make the repo root importable whether invoked via pytest or directly.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from backend.miners.bitaxe import BitaxeDriver  # noqa: E402


def _sample_info(**overrides):
    """A minimal /api/system/info payload. Defaults model a single-ASIC
    BM1370 Bitaxe (one chip sensor); tests override temp/temp2."""
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


def test_suprahex_two_sensors_max_and_second():
    """The reported case: temp=46.6875, temp2=58.625 (SupraHex 701).
    temp_chip_c must be the hotter sensor; temp_chip_2_c the second one."""
    sample = _parse(temp=46.6875, temp2=58.625)

    assert sample.temp_chip_2_c == 58.625
    # max of the two sensors, rounded to 1dp like the other drivers.
    assert sample.temp_chip_c == 58.6


def test_max_is_taken_when_sensor1_is_hotter():
    """Order-independence: if sensor 1 is the hotter one, it wins."""
    sample = _parse(temp=70.2, temp2=51.0)

    assert sample.temp_chip_c == 70.2
    assert sample.temp_chip_2_c == 51.0


def test_single_sensor_board_unchanged():
    """A board with no temp2 keeps the legacy behaviour: temp_chip_c == temp
    and temp_chip_2_c is None (so the UI drops the second row)."""
    sample = _parse(temp=55.0)

    assert sample.temp_chip_2_c is None
    assert sample.temp_chip_c == 55.0


def test_sentinel_temp2_treated_as_absent():
    """Firmware reports an unpopulated sensor as -1 (and 0 is never a real
    chip reading). Either must be treated as missing — not folded into the
    max and not surfaced as a phantom 0 °C / -1 °C reading."""
    for sentinel in (-1, -1.0, 0, 0.0):
        sample = _parse(temp=55.0, temp2=sentinel)
        assert sample.temp_chip_2_c is None, f"temp2={sentinel!r}"
        assert sample.temp_chip_c == 55.0, f"temp2={sentinel!r}"


def test_sentinel_temp1_does_not_poison_max():
    """If sensor 1 is the sentinel but sensor 2 is real, the chip temp must
    come from sensor 2 — not collapse to None."""
    sample = _parse(temp=-1, temp2=58.625)

    assert sample.temp_chip_c == 58.6
    assert sample.temp_chip_2_c == 58.625


def test_both_sensors_absent_leaves_none():
    sample = _parse(temp=-1, temp2=-1)

    assert sample.temp_chip_c is None
    assert sample.temp_chip_2_c is None


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
