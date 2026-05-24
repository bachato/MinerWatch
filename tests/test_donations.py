# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for the Donate-hashrate feature.

Three layers, none of which need a real miner:
  * pure helpers — PoolConfig JSON round-trip, _split_host_port
  * BitaxeDriver pool control — set_pool builds the right PATCH payload
    and read_pool_config maps the AxeOS fields (HTTP stubbed out)
  * DonationController flow — start → reject-double → boot catch-up revert
    against a temp SQLite DB and a fake driver

Async paths are driven with ``asyncio.run`` so the suite needs no
pytest-asyncio plugin. Runs under pytest, or standalone:
``python tests/test_donations.py``.
"""
from __future__ import annotations

import asyncio
import pathlib
import sys

# Make the repo root importable whether invoked via pytest or directly.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from backend.miners.base import PoolConfig  # noqa: E402
from backend.miners.bitaxe import BitaxeDriver, _split_host_port  # noqa: E402
import backend.db as db  # noqa: E402
import backend.donations as dons  # noqa: E402


# ---- pure helpers -----------------------------------------------------------

def test_poolconfig_roundtrip():
    pc = PoolConfig(
        url="solo.ckpool.org", port=3333, user="addr.donations", password="x",
        fb_url="backup.pool", fb_port=4444, fb_user="addr.backup",
    )
    back = PoolConfig.from_json(pc.to_json())
    assert back == pc


def test_split_host_port_bare_host():
    assert _split_host_port("solo.ckpool.org", 3333) == ("solo.ckpool.org", 3333)


def test_split_host_port_combined_and_scheme():
    # combined host:port with no explicit port → split
    assert _split_host_port("pool.example:1234", None) == ("pool.example", 1234)
    # scheme prefix is stripped
    assert _split_host_port("stratum+tcp://pool.example", 3333) == ("pool.example", 3333)


def test_donation_pool_config_uses_project_address():
    cfg = dons.donation_pool_config()
    assert cfg.url == dons.CKPOOL_SOLO_URL
    assert cfg.port == dons.CKPOOL_SOLO_PORT
    assert cfg.user == f"{dons.DONATION_BTC_ADDRESS}.{dons.DONATION_WORKER}"


# ---- BitaxeDriver pool control (HTTP stubbed) -------------------------------

def test_bitaxe_set_pool_payload_and_restart():
    drv = BitaxeDriver("10.0.0.1")
    captured = {}

    async def fake_patch(payload):
        captured["payload"] = payload
        return True

    async def fake_restart():
        captured["restarted"] = True
        return True

    drv._patch_system = fake_patch          # type: ignore[assignment]
    drv.restart = fake_restart              # type: ignore[assignment]

    cfg = PoolConfig(url="solo.ckpool.org", port=3333, user="addr.donations", password=None)
    ok = asyncio.run(drv.set_pool(cfg))

    assert ok is True
    assert captured["restarted"] is True       # stratum change needs a restart
    p = captured["payload"]
    assert p["stratumURL"] == "solo.ckpool.org"
    assert p["stratumPort"] == 3333
    assert p["stratumUser"] == "addr.donations"
    assert p["stratumPassword"] == "x"         # None → "x" (ckpool ignores it)


def test_bitaxe_read_pool_config_maps_fields():
    drv = BitaxeDriver("10.0.0.1")

    async def fake_info():
        return {
            "stratumURL": "192.168.1.100",
            "stratumPort": 2018,
            "stratumUser": "bc1qprimary.worker",
            "fallbackStratumURL": "192.168.1.50",
            "fallbackStratumPort": 4567,
            "fallbackStratumUser": "bc1qfallback.worker",
        }

    drv._system_info = fake_info               # type: ignore[assignment]
    cfg = asyncio.run(drv.read_pool_config())

    assert cfg.url == "192.168.1.100"
    assert cfg.port == 2018
    assert cfg.user == "bc1qprimary.worker"
    assert cfg.fb_url == "192.168.1.50"
    assert cfg.fb_port == 4567
    assert cfg.fb_user == "bc1qfallback.worker"
    # AxeOS doesn't expose the password — must come back None.
    assert cfg.password is None


# ---- DonationController flow (temp DB + fake driver) ------------------------

class _FakeDriver:
    """Stand-in AxeOS driver that records set_pool calls."""

    can_set_pool = True

    def __init__(self, prev: PoolConfig, log: list):
        self._prev = prev
        self._log = log

    async def read_pool_config(self) -> PoolConfig:
        return self._prev

    async def set_pool(self, config: PoolConfig) -> bool:
        self._log.append((config.url, config.user))
        return True


def test_controller_start_revert_flow(tmp_path, monkeypatch):
    db_file = tmp_path / "mw.db"
    monkeypatch.setattr(db, "db_path", lambda: str(db_file))

    set_pool_calls: list = []
    original_pool = PoolConfig(url="myhome.pool", port=3333, user="myworker")
    monkeypatch.setattr(
        dons, "driver_for_record", lambda rec: _FakeDriver(original_pool, set_pool_calls)
    )

    async def scenario():
        await db.init_db()
        mid = await db.upsert_miner(
            {"name": "bitaxe-1", "family": "bitaxe", "host": "10.0.0.9"}
        )

        # start a donation
        res = await dons.donation_controller.start_donation([mid], hours=1)
        assert res["miners"][0]["status"] == "active"
        assert set_pool_calls[-1][0] == dons.CKPOOL_SOLO_URL

        # the same miner can't be donated twice while in flight
        res2 = await dons.donation_controller.start_donation([mid], hours=1)
        assert res2["miners"][0]["status"] == "error"

        # one active row visible
        active = await db.list_donation_miners(active_only=True)
        assert len(active) == 1

        # force the window to have elapsed, then run the boot catch-up
        don_id = res["donation_id"]
        async with db.connect() as c:
            await c.execute(
                "UPDATE donations SET ends_ts = ? WHERE id = ?",
                (db.now_ts() - 10, don_id),
            )
            await c.commit()
        await dons.donation_controller.catch_up_on_boot()

        # last set_pool restored the ORIGINAL pool, and the donation closed out
        assert set_pool_calls[-1][0] == "myhome.pool"
        assert await db.list_donation_miners(active_only=True) == []
        don = await db.get_donation(don_id)
        assert don["status"] == "completed"

    asyncio.run(scenario())


if __name__ == "__main__":  # standalone runner
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
