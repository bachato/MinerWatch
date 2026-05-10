<div align="center">

# MinerWatch

**A local-first dashboard for home Bitcoin miners.**

Monitor and control Bitaxe, NerdQAxe, Canaan Avalon Nano 3s and Braiins BMM
miners on your home network — all from your browser, no cloud, no telemetry.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](#)
[![No Warranty](https://img.shields.io/badge/warranty-none-red.svg)](#disclaimer)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

![dashboard screenshot placeholder](docs/screenshots/dashboard.png)

</div>

---

## What it is

MinerWatch is a small Python web app you run on your own machine (a Mac, a
Linux box, or a Raspberry Pi) on the same LAN as your miners. It polls each
device every few seconds, stores hash rate, temperature, power, fan and pool
data in a local SQLite database, and gives you a browser dashboard that
works from your phone, tablet, or laptop.

It is meant for **home / small-scale mining setups** (1–10 miners), users
comfortable opening a terminal but not necessarily developers.

## Features

- **Live dashboard** — hash rate, chip and VR temps, fans, power, accepted /
  rejected shares for every miner at a glance
- **Best-share tracker** — session and all-time best difficulty per miner
  and across the fleet, with native push when a miner breaks its own
  all-time record
- **Per-miner detail page** with Chart.js graphs over the last hours / days
- **Browser push notifications** (Web Push + VAPID) for over-temperature,
  miner-offline, miner-online recovery, and best-share records — works on
  macOS Chrome, native OS notifications
- **Auto-discovery** of miners on the LAN (port 80 for Bitaxe-class, port 4028
  for cgminer-based devices); MAC-pinned identity so DHCP IP changes don't
  break tracking
- **Optional bearer-token auth** for setups where the LAN isn't fully trusted
- **30 days of metrics retention** by default, configurable
- **One-click macOS launcher** plus a Docker setup for Linux / Raspberry Pi
- **No cloud, no account, no analytics** — all data stays on your box

## Supported miners

| Family          | Tested models                            | Protocol                |
|-----------------|------------------------------------------|-------------------------|
| Bitaxe          | Gamma 601 / 602, Supra, Ultra, Max       | HTTP REST :80           |
| NerdQAxe        | NerdQAxe+, NerdQAxe++                    | HTTP REST :80 (Bitaxe-compatible) |
| Canaan Avalon   | Nano 3s, Avalon Q                        | TCP cgminer-text :4028  |
| Braiins         | BMM 101 (BOSminer firmware)              | TCP cgminer-JSON :4028  |

Adding a new model usually means a single new file in `backend/miners/`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the driver template.

## Quick start

### macOS / Linux (one-line)

```bash
git clone https://github.com/<your-username>/MinerWatch.git
cd MinerWatch
chmod +x start.sh
./start.sh
```

The script creates a virtualenv in `.venv/`, installs the dependencies,
initialises the SQLite database in `data/`, and starts the FastAPI server
with auto-reload.

Then open:

- From the same machine: <http://localhost:8000>
- From any phone / tablet / PC on the same LAN: `http://<host-ip>:8000`

Stop with `Ctrl+C`, or `./stop.sh` if it was launched in the background.

### macOS one-click (recommended for non-developers)

Double-click `installer.command` from Finder. It will:

1. Copy MinerWatch into `~/Library/Application Support/MinerWatch/`.
2. Create the Python virtualenv there and install dependencies.
3. Register a **LaunchAgent** so MinerWatch starts automatically every
   time you log in, and restarts itself if it ever crashes.
4. Open the dashboard at `http://localhost:8000` in your browser.

The installer works no matter where you keep the source folder — Desktop,
Documents, Downloads, iCloud Drive, an external volume, anywhere. macOS
Privacy (TCC) blocks background launchd jobs from reading those locations,
so MinerWatch installs the running copy under `~/Library/Application
Support` (always accessible) and runs from there. After install, you can
move or delete the source folder; the service keeps running.

To update after editing the source: just double-click `installer.command`
again — it re-syncs the runtime copy.

To stop the auto-start, double-click `uninstaller.command`. It will offer
to wipe the runtime directory too (database + logs); answer `n` to keep
your data.

### Run as a service (auto-start at login / boot)

If you skipped the one-click installer, you can register the service
manually. The same script handles both macOS (launchd) and Linux (systemd):

```bash
./scripts/install-service.sh           # install + start
./scripts/install-service.sh --status  # show current state
./scripts/uninstall-service.sh         # remove
```

On **macOS** this installs a user-level LaunchAgent at
`~/Library/LaunchAgents/com.imlenti.minerwatch.plist`. Logs land in
`data/logs/minerwatch.{out,err}.log`.

On **Linux / Raspberry Pi** it installs a systemd user unit at
`~/.config/systemd/user/minerwatch.service`. Tail the logs with
`journalctl --user -u minerwatch -f`. To start MinerWatch at boot even
without an interactive login (typical headless Pi setup), enable lingering:

```bash
sudo loginctl enable-linger $USER
```

### Docker / Raspberry Pi (alternative)

```bash
docker compose up -d
```

The compose file mounts `./data` as a named volume so your metrics survive
container rebuilds.

## Architecture

```
                            ┌─────────────────────────┐
                            │  Browser (Chrome / etc) │
                            │  index.html · settings  │
                            └────────────┬────────────┘
                                         │  HTTP / WebPush
                                         ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                        FastAPI app                           │
   │  main.py  ·  auth.py  ·  alerts.py                           │
   │                                                              │
   │   ┌────────────┐    ┌──────────────┐                         │
   │   │  poller    │    │  discovery   │                         │
   │   │ (asyncio)  │    │  (LAN scan)  │                         │
   │   └─────┬──────┘    └──────┬───────┘                         │
   │         │                  │                                 │
   │         ▼                  ▼                                 │
   │   ┌──────────────────────────────┐                           │
   │   │   miners/  driver layer      │                           │
   │   │   bitaxe · canaan · braiins  │                           │
   │   └──────────────┬───────────────┘                           │
   │                  │                                           │
   │                  ▼                                           │
   │           ┌─────────────┐                                    │
   │           │  SQLite db  │   (data/minerwatch.db)             │
   │           └─────────────┘                                    │
   └──────────────────────────────────────────────────────────────┘
                                 │
                                 ▼  TCP / HTTP polling every 5s
                        ┌─────────────────┐
                        │  Miners on LAN  │
                        └─────────────────┘
```

More detail in [docs/architecture.md](docs/architecture.md).

## Configuration

The shipped defaults work for most home setups. To customise, copy
`config.example.yaml` to `config.yaml` and edit, **or** use the in-app
**Settings** page (UI changes take precedence over the file and are stored in
the database).

Highlights:

- `polling.interval_seconds` — how often miners are polled (default 5s)
- `network.scan_cidr` — subnet for auto-discovery (`auto` picks the host's
  current LAN, e.g. `192.168.1.0/24`)
- `alerts.temp_chip_threshold`, `alerts.temp_vr_threshold` — alert thresholds
- `auth.enabled` — turn on bearer-token auth

Full reference: [docs/configuration.md](docs/configuration.md).

## Push notifications

On first launch MinerWatch generates a VAPID key pair and stores it in
`data/vapid_keys.json` (treat this as private — it identifies your server
to subscribed browsers). On the **Settings** page click *Enable
notifications* to grant Chrome permission. From then on you'll get native
OS notifications for:

- Chip / VR temperature over threshold
- Miner offline beyond `offline_threshold_seconds`
- Miner coming back online
- Start / stop events

Re-alerts fire every 600 seconds while a critical condition persists, with a
sticky banner in the dashboard.

> **macOS note**: in addition to the per-site permission, you also need to
> allow notifications at the system level under *System Settings →
> Notifications → Google Chrome*. See
> [docs/faq.md](docs/faq.md).

## Optional auth

The defaults assume your home LAN is trusted, so no password is required.
To turn auth on, open *Settings → Password protection*, set a password,
and save — every API request and frontend page will then require the bearer
token.

## Discovery

On startup (and periodically) MinerWatch scans the configured subnet for
ports 80 (Bitaxe-class) and 4028 (cgminer / Avalon / Braiins). Detected
devices are auto-added and identified by MAC, so DHCP lease changes don't
break the time series. You can also add a miner manually from the UI by
hostname or IP.

The default `network.scan_cidr: "auto"` resolves at runtime to the
host's own /24 (e.g. if the Mac/Pi has IP `192.168.0.42`, the scanned
range is `192.168.0.0/24` — all 254 host addresses, from `.1` to
`.254`). You only need to override the CIDR manually if:

- the host has more than one active network interface (Wi-Fi + Ethernet,
  Wi-Fi + VPN, Wi-Fi + Thunderbolt bridge…) and the miners live on the
  one that isn't the default route — set the CIDR to the right LAN from
  *Settings → Network*;
- your LAN is wider than /24 (e.g. an enterprise /22 or /16) — set the
  CIDR to the actual range so all miners are covered;
- multiple VLANs are bridged through the same host — pick the one with
  the miners or run discovery once per VLAN with manual CIDRs.

## Troubleshooting

<details>
<summary><b>start.sh fails creating the virtualenv on macOS</b></summary>

Apple's bundled Python sometimes ships a broken `venv` module. Run
`./diagnose.sh` first — it tells you exactly what's wrong. The usual fix is:

```bash
brew install python
PYTHON_BIN=$(brew --prefix)/bin/python3 ./start.sh
```
</details>

<details>
<summary><b>Auto-discovery doesn't find any miner</b></summary>

99% of the time this is a wrong-subnet issue, not a connectivity one.
Open the logs (`data/logs/minerwatch.out.log` or
`journalctl --user -u minerwatch -f`) and look for the line
`Discovery: scanning <CIDR>`.

- If the CIDR shown is *not* the network your miners are on (e.g. logs
  say `192.168.1.0/24` but the miners are on `192.168.0.x`), set
  `network.scan_cidr` from the *Settings* page to the right CIDR.
  Common cases: the host has multiple interfaces (Wi-Fi + Ethernet,
  Wi-Fi + VPN), or the LAN is bigger than /24.
- If the log says
  `could not auto-detect the host's subnet`, the host has no default
  route at all. Set the CIDR manually from Settings.

You can always add a miner by IP/hostname from *Add miner* without
relying on discovery.
</details>

<details>
<summary><b>Push notifications are silent on macOS</b></summary>

Two layers of permission are required:

1. *In Chrome*: site permission for `http://localhost:8000` →
   Notifications → Allow
2. *In macOS*: System Settings → Notifications → Google Chrome → Allow
   notifications, with banner / alert style of your choice
</details>

<details>
<summary><b>Push fails with a "key parsing" or LibreSSL error</b></summary>

This is a known issue with Apple's LibreSSL. MinerWatch already works
around it by feeding the VAPID private key in raw base64 (not PEM). If
you see this error and you're not on macOS, please open an issue with
your `pip show pywebpush` and `python -c "import ssl; print(ssl.OPENSSL_VERSION)"`.
</details>

<details>
<summary><b>Braiins BMM 101 shows zeros for temperatures / fans</b></summary>

Braiins firmware doesn't populate `temps` / `fans` / `tunerstatus` on every
build. MinerWatch falls back gracefully but you'll see partial data. Try
upgrading to the latest BOSminer release.
</details>

<details>
<summary><b>Canaan Nano 3s power readings look off</b></summary>

Power is read from the `MPO[N]` field (watts, direct). The legacy `PS[...]`
fields use different units depending on firmware, so they're ignored.
</details>

More: [docs/faq.md](docs/faq.md).

## Adding a new miner driver

In short: drop a new file in `backend/miners/`, subclass `MinerDriver`,
implement `async def sample(self) -> MinerSample`, and register it. Full
walkthrough with a copy-pasteable template:
[docs/adding-a-miner.md](docs/adding-a-miner.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- [x] Best-share tracker (session / all-time per miner + fleet) with push
- [ ] Scheduling work mode based on electricity prices / solar production
- [ ] €/kWh cost calculator + ROI dashboard
- [ ] Solo-lottery odds card (network difficulty vs your hashrate)
- [ ] MQTT export + Home Assistant discovery
- [ ] Remote access guidance (Tailscale, reverse tunnel)
- [ ] Test suite (currently none — contributions welcome)
- [ ] Extra drivers: full Antminer line via cgminer, Whatsminer

## Contributing

Bug reports, pull requests, and new miner drivers are very welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) and our
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MinerWatch is released under the **GNU Affero General Public License v3.0**
([full text](LICENSE)).

In short:

- You can run, study, modify, and redistribute it for free.
- If you fork it and distribute the fork, you must release your changes
  under the same license.
- **If you run a modified version as a network service** (e.g. as a hosted
  SaaS), you must make the modified source code available to your users.

This is the same license used by Mastodon, Nextcloud and Plausible
Analytics.

## Disclaimer

MinerWatch is provided **"as is"**, without warranty of any kind. It talks
to your hardware over the LAN; misconfiguration could in theory damage a
device (over-tuning, fan stop, etc.). Use it on equipment you own, on a
network you control, and verify the alert thresholds against your hardware
spec sheet.

This project is not affiliated with Bitaxe, NerdQAxe, Canaan, Braiins,
HashWatcher, or Engineered Essentials Ventures.

## Acknowledgements

- The hobbyist Bitcoin home-mining community for documenting hashboard
  protocols
- The Bitaxe / OSMU project for an exemplary open hardware miner
- HashWatcher for being the inspiration that made me want a local-first,
  open-source alternative
- The Braiins / BOSminer team for keeping `cgminer-API` documented
