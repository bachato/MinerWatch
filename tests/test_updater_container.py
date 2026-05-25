# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for updater.in_container() — the container-detection guard.

This guard decides whether the in-app self-update is allowed. Under
Docker/Umbrel it must be disabled (the image is immutable, so a file swap
would be discarded on the next container recreate). On a bare-metal
macOS/Linux install it MUST stay enabled — misclassifying bare-metal as a
container would silently break a working feature.

The most important assertions here are the bare-metal ones:
  * env var unset AND no /.dockerenv sentinel  -> NOT a container
  * env var explicitly "0"/"false"             -> NOT a container (override)

so the existing self-update path on macOS/Linux is provably untouched.

Runs under pytest, or standalone: ``python tests/test_updater_container.py``.
"""
from __future__ import annotations

import os
import pathlib
import sys

# Make the repo root importable whether invoked via pytest or directly.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from backend import updater  # noqa: E402

ENV = "MINERWATCH_CONTAINER"


def _run(env_value, dockerenv_present):
    """Call in_container() with a controlled env var and /.dockerenv state.

    Saves and restores both the env var and the patched os.path.exists so
    tests don't leak state into one another.
    """
    prev_env = os.environ.get(ENV)
    prev_exists = updater.os.path.exists
    try:
        if env_value is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = env_value
        updater.os.path.exists = lambda p: (
            True if p == "/.dockerenv" else prev_exists(p)
        ) if dockerenv_present else (
            False if p == "/.dockerenv" else prev_exists(p)
        )
        return updater.in_container()
    finally:
        if prev_env is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = prev_env
        updater.os.path.exists = prev_exists


# ---- Bare-metal: the cases that must stay "not a container" ----

def test_bare_metal_env_unset_no_sentinel_is_not_container():
    assert _run(None, dockerenv_present=False) is False


def test_explicit_false_overrides_sentinel():
    # Even if /.dockerenv exists, an explicit "0"/"false" wins → bare-metal.
    for val in ("0", "false", "no", "off", "FALSE"):
        assert _run(val, dockerenv_present=True) is False, val


# ---- Container: the cases that must disable the in-app update ----

def test_explicit_true_is_container():
    for val in ("1", "true", "yes", "on", "TRUE", " 1 "):
        assert _run(val, dockerenv_present=False) is True, val


def test_env_unset_with_sentinel_is_container():
    # Generic container (no explicit env) detected via the Docker sentinel.
    assert _run(None, dockerenv_present=True) is True


def test_unrecognised_value_falls_back_to_sentinel():
    # A value we don't recognise as truthy/falsy → defer to /.dockerenv.
    assert _run("maybe", dockerenv_present=False) is False
    assert _run("maybe", dockerenv_present=True) is True


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
