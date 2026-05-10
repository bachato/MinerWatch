# Contributing to MinerWatch

Thanks for considering a contribution! MinerWatch is a small, focused
project — bug reports, doc improvements, and especially **new miner
drivers** are all welcome.

By participating you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). All contributions are licensed
under [AGPL-3.0-only](LICENSE).

---

## Quick map of the codebase

```
backend/
  main.py              FastAPI app, all 39 HTTP routes
  config.py            settings + DB-overridable values
  db.py                SQLite schema + helpers (autocommit)
  alerts.py            VAPID Web Push + alert state machine
  poller.py            asyncio polling loop
  discovery.py         LAN /24 scan
  auth.py              optional bearer-token middleware
  miners/
    base.py            MinerSample dataclass + MinerDriver ABC
    bitaxe.py          REST :80
    canaan.py          cgminer-text :4028 + Avalon MM regex
    braiins.py         cgminer-JSON :4028 + Braiins extensions
    cgminer_client.py  TCP client + JSON / pipe parsers
frontend/              vanilla HTML / JS / Chart.js + service worker
config.example.yaml    starter config
start.sh / stop.sh     macOS / Linux launcher
```

Source comments and docstrings are in **Italian**; user-facing files
(README, docs, this file, the issue / PR templates) are in English.
Please keep that split — don't translate existing code comments, just
match the local style when you add new ones.

## Dev setup

You need Python **3.10+**. 3.9 works in a pinch but a few stdlib
features used by FastAPI 0.115 are happier on 3.10.

```bash
git clone https://github.com/<you>/MinerWatch.git
cd MinerWatch
chmod +x start.sh
./start.sh
```

`start.sh` creates `.venv/`, installs dependencies, initialises the DB,
and runs uvicorn with `--reload`. Edits to `backend/*.py` reload
automatically; edits to `frontend/*` are picked up on browser refresh.

If `start.sh` fails on your Mac, run `./diagnose.sh` first.

### Running by hand

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Sanity checks

There is no formal test suite yet — for now the bar is just:

```bash
python -m py_compile $(find backend -name '*.py')
ruff check backend/                 # if you have ruff installed
black --check backend/              # optional
```

CI runs the `py_compile` import check on every PR.

## How to add a new miner driver

A driver is a small subclass of `MinerDriver` that knows how to talk to
**one** miner over its network protocol and produce a `MinerSample`.

### 1. Create the file

`backend/miners/<your_family>.py`:

```python
# SPDX-License-Identifier: AGPL-3.0-only
"""Driver for the <Brand Family> miner family."""
from __future__ import annotations

import httpx  # or asyncio TCP, whatever fits the protocol

from .base import MinerDriver, MinerSample


class MyMinerDriver(MinerDriver):
    family = "myminer"          # short lowercase ID, used in the registry
    DEFAULT_PORT = 80           # whatever your firmware listens on

    # Capability flags — set True only if you actually implement the action.
    can_set_fan = False
    can_set_frequency = False
    can_set_voltage = False
    can_restart = False

    async def poll(self) -> MinerSample:
        url = f"http://{self.host}:{self.port}/api/system/info"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.get(url)
                r.raise_for_status()
                data = r.json()
        except Exception as exc:  # noqa: BLE001
            return MinerSample(
                family=self.family,
                host=self.host,
                online=False,
                error=str(exc),
            )

        return MinerSample(
            family=self.family,
            host=self.host,
            online=True,
            mac=data.get("mac"),
            model=data.get("model"),
            hostname=data.get("hostname"),
            firmware_version=data.get("firmware"),
            hashrate_ths=data.get("hashRate") and data["hashRate"] / 1000,
            power_w=data.get("power"),
            temp_chip_c=data.get("tempChip"),
            temp_vr_c=data.get("tempVR"),
            fan_rpm=data.get("fanRpm"),
            fan_pct=data.get("fanPercent"),
            frequency_mhz=data.get("frequency"),
            voltage_mv=data.get("voltage"),
            uptime_s=data.get("uptime"),
            accepted=data.get("sharesAccepted"),
            rejected=data.get("sharesRejected"),
            best_difficulty=data.get("bestDifficulty"),
            pool_url=data.get("poolURL"),
            worker=data.get("worker"),
            raw=data,            # keep the original payload for debugging
        )
```

Fields you can't read should stay `None` — the dashboard renders missing
data as `—`.

### 2. Register it

Edit `backend/miners/__init__.py`:

```python
from .myminer import MyMinerDriver

DRIVERS: dict[str, Type[MinerDriver]] = {
    "bitaxe": BitaxeDriver,
    "canaan": CanaanDriver,
    "braiins": BraiinsDriver,
    "myminer": MyMinerDriver,        # ← add this
}
```

### 3. Teach discovery (optional)

If your miner can be auto-detected by an open port + signature, add the
detection logic in `backend/discovery.py`. If it needs to be added by
hand, that's fine — users can do it from the *Settings → Add miner* UI.

### 4. Test it

Run `./start.sh` and add the miner in Settings. Check the detail page
shows the metrics you mapped, and that the dashboard tile updates each
poll cycle.

### 5. Document it

Add a row to the *Supported miners* table in `README.md` and a short
section in `docs/adding-a-miner.md` if your driver has firmware-specific
quirks worth flagging (eg. unit conversions, missing fields on certain
firmware versions). Brief is fine — just enough that the next person
won't have to re-discover the trap.

## Style conventions

- Python: PEP 8, ~100 col soft limit. `black` and `ruff` are recommended
  but not enforced.
- Type hints encouraged on public functions. Use `from __future__ import
  annotations` to keep the runtime cheap.
- Avoid adding heavy dependencies — the project deliberately ships with
  a small `requirements.txt`.
- Frontend: vanilla JS, no build step. If a feature really needs a
  framework, open an issue first.

## Pull-request checklist

Before opening a PR:

- [ ] `python -m py_compile $(find backend -name '*.py')` is clean
- [ ] If you touched a driver, you tested against real hardware **or**
      added a `raw` payload sample in the PR description so reviewers can
      reason about it
- [ ] README / docs updated if behaviour changed
- [ ] CHANGELOG entry under `## [Unreleased]`
- [ ] No personal data committed (IPs, MACs, wallet addresses, pool
      credentials, screenshots with usernames)
- [ ] You agree to license your contribution under AGPL-3.0-only

## Reporting a bug

Please use the *Bug report* issue template. Useful info:

- MinerWatch commit / version
- Python version, OS
- Miner family + firmware
- Relevant log lines (uvicorn output)
- For driver bugs, the `raw` payload from the affected miner

## Reporting a security issue

For anything that might affect users running MinerWatch on a
non-trusted network — open a private GitHub Security Advisory rather
than a public issue.

Thanks again — every PR helps!
