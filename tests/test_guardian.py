# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for the Guardian runtime frequency governor.

Covers the pure decision function ``decide_frequency`` (the control policy)
and the windowed HW-error-% helper ``_hw_error_pct`` (counter-delta logic).
Both are pure / state-only, so they can be exercised without a miner, a
poller, or the event loop.

Runs under pytest, or standalone: ``python tests/test_guardian.py``.
"""
from __future__ import annotations

import pathlib
import sys
import types

# Make the repo root importable whether invoked via pytest or directly.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from backend.guardian import (  # noqa: E402
    _GuardianState,
    _hw_error_pct,
    decide_frequency,
)

# Defaults mirroring GuardianCfg / the friend's field-tested values.
DEFAULTS = dict(
    ceiling_mhz=600,
    floor_mhz=400,
    vr_high_c=70.0,
    vr_low_c=65.0,
    hw_error_pct_max=1.1,
    step_down_vr_mhz=20,
    step_down_err_mhz=10,
    step_up_mhz=10,
)


def decide(**over):
    """decide_frequency with the standard thresholds, returning the target."""
    kwargs = {**DEFAULTS, **over}
    return decide_frequency(**kwargs)


# ---- the control law --------------------------------------------------------

def test_vr_hot_steps_down_20():
    target, reason = decide(current_freq=550, vr_temp_c=72.0, hw_error_pct=0.0)
    assert target == 530, reason


def test_errors_high_step_down_10():
    target, reason = decide(current_freq=550, vr_temp_c=67.0, hw_error_pct=1.5)
    assert target == 540, reason


def test_vr_cool_steps_up_10():
    target, reason = decide(current_freq=550, vr_temp_c=60.0, hw_error_pct=0.0)
    assert target == 560, reason


def test_deadband_holds():
    # Between vr_low (65) and vr_high (70), errors fine → no change.
    target, reason = decide(current_freq=550, vr_temp_c=67.0, hw_error_pct=0.2)
    assert target == 550
    assert "hold" in reason


def test_up_step_capped_at_ceiling():
    # Cool VR wants +10 but we're at the ceiling already → hold.
    target, reason = decide(current_freq=600, vr_temp_c=60.0, hw_error_pct=0.0)
    assert target == 600
    assert "limit" in reason


def test_down_step_clamped_at_floor():
    target, reason = decide(current_freq=400, vr_temp_c=80.0, hw_error_pct=0.0)
    assert target == 400
    assert "limit" in reason


def test_above_ceiling_is_capped_first():
    # User manually overclocked past the cap: pull back to the ceiling even
    # though the VR is cool (which would otherwise want to push UP).
    target, reason = decide(current_freq=700, vr_temp_c=55.0, hw_error_pct=0.0)
    assert target == 600
    assert "cap" in reason


def test_below_floor_is_raised_first():
    target, reason = decide(current_freq=350, vr_temp_c=80.0, hw_error_pct=5.0)
    assert target == 400
    assert "floor" in reason


# ---- priority between branches ---------------------------------------------

def test_vr_hot_beats_errors():
    # Both VR>70 and errors high → the bigger (VR) cut wins.
    target, _ = decide(current_freq=550, vr_temp_c=75.0, hw_error_pct=9.9)
    assert target == 530  # -20, not -10


def test_errors_beat_cool_recovery():
    # VR is cool (would want +10) but errors are high → safety wins, step down.
    target, reason = decide(current_freq=550, vr_temp_c=60.0, hw_error_pct=2.0)
    assert target == 540, reason


# ---- missing sensors --------------------------------------------------------

def test_no_vr_no_errors_holds():
    target, reason = decide(current_freq=550, vr_temp_c=None, hw_error_pct=None)
    assert target == 550
    assert "hold" in reason


def test_no_errors_vr_governs():
    # Nerd* case: no usable HW% → error term inactive, VR still governs.
    target, _ = decide(current_freq=550, vr_temp_c=72.0, hw_error_pct=None)
    assert target == 530


def test_no_vr_errors_still_act():
    target, _ = decide(current_freq=550, vr_temp_c=None, hw_error_pct=3.0)
    assert target == 540


# ---- defensive: floor above ceiling shouldn't brick the loop ---------------

def test_floor_above_ceiling_clamped():
    # floor(620) > ceiling(600): the function clamps floor to ceiling, so a
    # cool-VR up-step lands on the ceiling and holds rather than exploding.
    target, _ = decide(current_freq=600, floor_mhz=620, vr_temp_c=60.0, hw_error_pct=0.0)
    assert target == 600


# ---- HW% windowed helper ----------------------------------------------------

def _sample(hw_errors, hw_total):
    return types.SimpleNamespace(hw_errors=hw_errors, hw_total=hw_total)


def test_hw_pct_first_tick_is_none_and_sets_baseline():
    st = _GuardianState()
    pct = _hw_error_pct(st, _sample(100, 10_000))
    assert pct is None
    assert st.prev_hw_errors == 100 and st.prev_hw_total == 10_000


def test_hw_pct_computes_delta_over_interval():
    st = _GuardianState()
    _hw_error_pct(st, _sample(100, 10_000))          # baseline
    pct = _hw_error_pct(st, _sample(110, 11_000))     # +10 err / +1000 work
    assert pct is not None
    assert abs(pct - 1.0) < 1e-9                       # 10/1000 = 1.0%


def test_hw_pct_counter_reset_returns_none():
    st = _GuardianState()
    _hw_error_pct(st, _sample(500, 50_000))
    # Miner rebooted → counters dropped: must not produce a negative/garbage %.
    pct = _hw_error_pct(st, _sample(5, 500))
    assert pct is None
    # Baseline re-anchored to the new (lower) counters.
    assert st.prev_hw_errors == 5 and st.prev_hw_total == 500


def test_hw_pct_no_denominator_returns_none():
    # Nerd*: hw_total is None → no % computable on either tick.
    st = _GuardianState()
    _hw_error_pct(st, _sample(100, None))
    pct = _hw_error_pct(st, _sample(150, None))
    assert pct is None


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
