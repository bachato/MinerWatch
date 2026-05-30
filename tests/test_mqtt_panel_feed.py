# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for the MQTT consolidated panel feed (backend/mqtt.panel_feed).

Pure-function tests — no broker, no I/O. The panel feed is the single
``<base>/panel`` blob the ESPHome touch panel subscribes to. Runs under
pytest, or standalone: ``python tests/test_mqtt_panel_feed.py``.
"""
from __future__ import annotations

import json
import pathlib
import sys

# Make the repo root importable whether invoked via pytest or directly.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from backend.miners.base import MinerSample  # noqa: E402
from backend.mqtt import _num, panel_feed  # noqa: E402


def _sample(**kw) -> MinerSample:
    return MinerSample(
        family=kw.pop("family", "bitaxe"),
        host=kw.pop("host", "10.0.0.5"),
        **kw,
    )


def test_num_coercion() -> None:
    assert _num(None) is None
    assert _num("nope") is None
    assert _num(4.987) == 4.99
    assert _num(95) == 95.0


def test_panel_feed_shape_names_and_values() -> None:
    miners = [
        {"id": 1, "mac": "E0:E1:A9:3F:0C:BF", "name": "Avalon Q"},
        {"id": 2, "mac": "AA:BB:CC:DD:EE:FF"},  # no rec name -> hostname fallback
    ]
    samples = {
        1: _sample(host="10.0.0.11", online=True, model="Avalon Nano 3",
                   hashrate_ths=4.9, power_w=95.0, temp_chip_c=62.0, temp_vr_c=70.0),
        2: _sample(host="10.0.0.12", online=False, hostname="bitaxe-2"),
    }
    feed = panel_feed(miners, samples)
    assert set(feed) == {"miners"}
    rows = feed["miners"]
    assert len(rows) == 2

    a = rows[0]
    assert a["id"] == "e0e1a93f0cbf"          # sanitized MAC
    assert a["name"] == "Avalon Q"            # from the DB record
    assert a["ip"] == "10.0.0.11"             # sample.host
    assert a["model"] == "Avalon Nano 3"
    assert (a["hr"], a["pw"], a["tp"], a["vr"]) == (4.9, 95.0, 62.0, 70.0)
    assert a["on"] is True

    b = rows[1]
    assert b["id"] == "aabbccddeeff"
    assert b["name"] == "bitaxe-2"            # hostname fallback
    assert b["ip"] == "10.0.0.12"
    assert b["on"] is False
    assert b["hr"] is None                    # offline / no data -> null
    assert b["vr"] is None                    # VR not reported -> null

    # Must be JSON-serialisable (exactly what the publisher does).
    assert json.loads(json.dumps(feed)) == feed


def test_panel_feed_missing_sample() -> None:
    miners = [{"id": 9, "mac": "", "name": "Ghost", "host": "10.0.0.99"}]
    feed = panel_feed(miners, {})             # no sample for id 9
    row = feed["miners"][0]
    assert row["name"] == "Ghost"
    assert row["ip"] == "10.0.0.99"           # falls back to the rec address
    assert row["on"] is False
    assert row["hr"] is None


if __name__ == "__main__":
    test_num_coercion()
    test_panel_feed_shape_names_and_values()
    test_panel_feed_missing_sample()
    print("ok — panel_feed tests passed")
