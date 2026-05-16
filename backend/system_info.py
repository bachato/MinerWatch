# SPDX-License-Identifier: AGPL-3.0-only
"""Host system metrics — Raspberry Pi focus.

This module is responsible for the "System" page of the UI when
MinerWatch happens to be running on a Raspberry Pi. The whole module is
written so that it stays harmless on non-Pi hosts (e.g. the macOS dev
machine): every call still returns a JSON-able dict, just with most
fields set to ``None`` and ``is_raspberry=False``. The frontend uses the
``is_raspberry`` flag to decide whether to show the "System" sidebar
entry at all, so on a Mac nothing changes visually.

What's collected
----------------

Static (computed once at import, see :func:`_detect_host`):
  - is_raspberry, model string, kernel, total RAM, DB path
  - fan controllability + RPM availability (sysfs discovery)
  - whether ``vcgencmd`` is reachable (Pi-specific firmware queries)

Dynamic (computed on each :func:`snapshot` call, ~5 s cadence):
  - CPU %, per-core %, load averages
  - RAM used/total/percent, swap used/total/percent
  - Disk used/total/percent (root filesystem)
  - Disk I/O rate (read/write bytes/s, smoothed against the previous call)
  - Network I/O rate (RX/TX bytes/s per primary interface)
  - CPU temperature (°C) — via /sys/class/thermal
  - CPU frequency (MHz) — current vs. nominal
  - Core voltage (V) — vcgencmd
  - Throttling flags (current + sticky-since-boot)
  - System uptime
  - MinerWatch DB size on disk
  - Fan RPM (if a tach is wired) + current PWM duty (if controllable)

Fan control
-----------

The Pi 4 has no built-in fan controller — fan setups vary wildly. To
stay flexible without hard-coding any single approach we discover the
fan through sysfs only:

  * **PWM duty** is set via /sys/class/thermal/cooling_device*/cur_state.
    This works out of the box if the user adds the standard kernel
    overlay to ``/boot/firmware/config.txt`` (Bookworm) or
    ``/boot/config.txt`` (older releases):

        dtoverlay=gpio-fan,gpiopin=14,temp=55000

    The overlay also handles the GPIO setup, so MinerWatch doesn't need
    to touch any GPIO library or run as root.

  * **RPM** is read from /sys/class/hwmon/*/fan1_input if the fan has a
    tach wire connected to a GPIO that exposes a hwmon driver
    (e.g. via the ``pwm-fan`` overlay).

If neither sysfs node exists, ``fan.controllable`` and ``fan.has_rpm``
stay False and the UI hides the slider / RPM widgets entirely. The
controller can be added later without touching this code.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

log = logging.getLogger("minerwatch.system")

try:
    import psutil  # type: ignore
    _HAS_PSUTIL = True
except ImportError:  # pragma: no cover — only triggers if user skipped pip install
    psutil = None  # type: ignore
    _HAS_PSUTIL = False
    log.warning("psutil not installed — /api/system/* endpoints will be degraded")


# ---------- Static host detection (cached at import) ----------

@dataclass
class HostInfo:
    """Static, immutable-for-this-process info about the host."""

    is_raspberry: bool = False
    model: Optional[str] = None
    kernel: Optional[str] = None
    ram_total_bytes: Optional[int] = None
    cpu_count: Optional[int] = None
    has_vcgencmd: bool = False

    # Fan support discovered in sysfs
    fan_cooling_path: Optional[str] = None       # cooling_device with PWM/state control
    fan_cooling_max_state: Optional[int] = None  # number of usable steps (e.g. 0..N)
    fan_rpm_path: Optional[str] = None           # /sys/class/hwmon/.../fan1_input


_VCGENCMD: Optional[str] = None  # path to vcgencmd binary if found


def _read_first_line(path: str) -> Optional[str]:
    """Read the first line of *path*, stripping NULs and trailing whitespace.

    /proc/device-tree files are NUL-terminated, which trips up naive str()
    handling — hence the explicit strip("\\x00").
    """
    try:
        with open(path, "r", errors="replace") as f:
            return f.readline().strip().strip("\x00")
    except (OSError, ValueError):
        return None


def _read_file(path: str) -> Optional[str]:
    try:
        with open(path, "r", errors="replace") as f:
            return f.read().strip().strip("\x00")
    except (OSError, ValueError):
        return None


def _find_vcgencmd() -> Optional[str]:
    """Locate vcgencmd, the Pi-specific firmware-query helper."""
    candidates = ["/usr/bin/vcgencmd", "/opt/vc/bin/vcgencmd"]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    found = shutil.which("vcgencmd")
    return found


def _discover_fan_paths() -> Tuple[Optional[str], Optional[int], Optional[str]]:
    """Look for a controllable fan + RPM tach in sysfs.

    Returns ``(cooling_device_path, max_state, hwmon_fan_input_path)``.
    All three can be None — the caller treats that as "no fan available".
    """
    cooling_path: Optional[str] = None
    max_state: Optional[int] = None
    rpm_path: Optional[str] = None

    # 1) Look for a cooling_device that exposes a writable cur_state and
    #    whose type hints at a fan (gpio-fan, pwm-fan, …). On stock Pi
    #    images the gpio-fan overlay registers as type "gpio-fan".
    cooling_root = Path("/sys/class/thermal")
    if cooling_root.is_dir():
        for d in sorted(cooling_root.glob("cooling_device*")):
            try:
                dev_type = (d / "type").read_text(errors="replace").strip()
            except OSError:
                continue
            if "fan" not in dev_type.lower():
                continue
            try:
                max_raw = (d / "max_state").read_text(errors="replace").strip()
                max_state = int(max_raw)
            except (OSError, ValueError):
                continue
            cur = d / "cur_state"
            if cur.is_file() and os.access(cur, os.W_OK | os.R_OK):
                cooling_path = str(d)
                break

    # 2) Look for fan1_input across hwmon entries. The naming "fan1" is
    #    the Linux convention for the first fan exposed by a hwmon
    #    driver (pwm-fan, raspberrypi-hwmon, ...).
    hwmon_root = Path("/sys/class/hwmon")
    if hwmon_root.is_dir():
        for h in sorted(hwmon_root.iterdir()):
            fan_input = h / "fan1_input"
            if fan_input.is_file():
                rpm_path = str(fan_input)
                break

    return cooling_path, max_state, rpm_path


def _detect_host() -> HostInfo:
    """Run once at import. Cheap, blocking — no async needed."""
    info = HostInfo()

    model = _read_file("/proc/device-tree/model") or _read_file(
        "/sys/firmware/devicetree/base/model"
    )
    if model:
        info.model = model
        if "raspberry pi" in model.lower():
            info.is_raspberry = True

    # Secondary check via /proc/cpuinfo "Model:" line, helps when the
    # device-tree node is missing (some Pi-compatible boards or chroots).
    if not info.is_raspberry:
        cpuinfo = _read_file("/proc/cpuinfo") or ""
        if "raspberry pi" in cpuinfo.lower() or "bcm27" in cpuinfo.lower() \
                or "bcm28" in cpuinfo.lower():
            info.is_raspberry = True
            if not info.model:
                # Pick the Model line if available
                for line in cpuinfo.splitlines():
                    if line.lower().startswith("model"):
                        info.model = line.split(":", 1)[-1].strip()
                        break

    # Kernel
    try:
        info.kernel = os.uname().release
    except (OSError, AttributeError):
        info.kernel = None

    # CPU + RAM
    if _HAS_PSUTIL:
        try:
            info.cpu_count = psutil.cpu_count(logical=True)
        except Exception:  # noqa: BLE001
            pass
        try:
            info.ram_total_bytes = psutil.virtual_memory().total
        except Exception:  # noqa: BLE001
            pass

    # vcgencmd
    global _VCGENCMD
    _VCGENCMD = _find_vcgencmd()
    info.has_vcgencmd = _VCGENCMD is not None

    # Fan discovery — only meaningful on Linux/Pi, but cheap to attempt
    # everywhere (the paths just don't exist on macOS).
    cooling_path, max_state, rpm_path = _discover_fan_paths()
    info.fan_cooling_path = cooling_path
    info.fan_cooling_max_state = max_state
    info.fan_rpm_path = rpm_path

    return info


HOST: HostInfo = _detect_host()


# ---------- vcgencmd helpers ----------

def _vcgencmd(*args: str, timeout: float = 1.5) -> Optional[str]:
    """Call ``vcgencmd ARGS`` and return stripped stdout, or None on any error.

    Pi-specific; returns None outside the Pi. Bounded timeout because
    ``vcgencmd`` can occasionally hang if the firmware mailbox is busy
    (very rare but seen in the wild on overloaded systems).
    """
    if not _VCGENCMD:
        return None
    try:
        out = subprocess.run(
            [_VCGENCMD, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def _parse_throttled(value: Optional[str]) -> Dict[str, object]:
    """Parse ``vcgencmd get_throttled`` output into structured flags.

    Output format is ``throttled=0xNNNN``. Bit layout (from the
    Raspberry Pi firmware docs):

        0x1     Under-voltage detected
        0x2     ARM frequency capped
        0x4     Currently throttled
        0x8     Soft temperature limit active
        0x10000 Under-voltage has occurred since last reboot
        0x20000 ARM frequency capping has occurred since last reboot
        0x40000 Throttling has occurred since last reboot
        0x80000 Soft temperature limit has occurred since last reboot

    The "now" flags reflect *right now*; the "ever" flags are sticky for
    the lifetime of the kernel boot. The UI uses "now" for the live
    badge and "ever" to surface historical issues.
    """
    empty = {
        "raw": None, "now_undervoltage": None, "now_freq_capped": None,
        "now_throttled": None, "now_soft_temp_limit": None,
        "ever_undervoltage": None, "ever_freq_capped": None,
        "ever_throttled": None, "ever_soft_temp_limit": None,
    }
    if not value:
        return empty
    # value is like "throttled=0x50000"
    try:
        hex_part = value.split("=", 1)[1].strip()
        bits = int(hex_part, 16)
    except (IndexError, ValueError):
        return empty
    return {
        "raw": hex_part,
        "now_undervoltage":      bool(bits & 0x1),
        "now_freq_capped":       bool(bits & 0x2),
        "now_throttled":         bool(bits & 0x4),
        "now_soft_temp_limit":   bool(bits & 0x8),
        "ever_undervoltage":     bool(bits & 0x10000),
        "ever_freq_capped":      bool(bits & 0x20000),
        "ever_throttled":        bool(bits & 0x40000),
        "ever_soft_temp_limit":  bool(bits & 0x80000),
    }


def _parse_volts(value: Optional[str]) -> Optional[float]:
    """``vcgencmd measure_volts core`` → ``volt=0.8500V`` → 0.85."""
    if not value:
        return None
    try:
        v = value.split("=", 1)[1].rstrip("V").strip()
        return float(v)
    except (IndexError, ValueError):
        return None


def _parse_freq(value: Optional[str]) -> Optional[int]:
    """``vcgencmd measure_clock arm`` → ``frequency(48)=1500000000`` → 1500 (MHz)."""
    if not value:
        return None
    try:
        hz = int(value.split("=", 1)[1].strip())
        return int(hz / 1_000_000)
    except (IndexError, ValueError):
        return None


def _parse_temp(value: Optional[str]) -> Optional[float]:
    """``vcgencmd measure_temp`` → ``temp=44.4'C`` → 44.4."""
    if not value:
        return None
    try:
        t = value.split("=", 1)[1].split("'")[0]
        return float(t)
    except (IndexError, ValueError):
        return None


# ---------- Linux /sys & /proc readers ----------

def _read_cpu_temp_sysfs() -> Optional[float]:
    """Return CPU temp in °C from /sys/class/thermal.

    Fallback for non-Pi Linux systems (where vcgencmd isn't around) and
    for the Pi when vcgencmd happens to be slow. Pi 4 exposes the SoC
    sensor as thermal_zone0.
    """
    paths = ["/sys/class/thermal/thermal_zone0/temp"]
    for p in paths:
        v = _read_file(p)
        if v is None:
            continue
        try:
            n = float(v)
        except ValueError:
            continue
        # Kernel reports millidegrees Celsius (44123 → 44.1 °C).
        if n > 200:
            n /= 1000.0
        return round(n, 1)
    return None


def _read_load_average() -> Optional[List[float]]:
    """Return [1min, 5min, 15min] load. /proc on Linux, psutil on macOS."""
    line = _read_file("/proc/loadavg")
    if line:
        parts = line.split()
        try:
            return [float(parts[0]), float(parts[1]), float(parts[2])]
        except (IndexError, ValueError):
            pass
    if _HAS_PSUTIL and hasattr(psutil, "getloadavg"):
        try:
            la = psutil.getloadavg()
            return [float(la[0]), float(la[1]), float(la[2])]
        except Exception:  # noqa: BLE001
            return None
    return None


def _read_uptime_seconds() -> Optional[int]:
    line = _read_file("/proc/uptime")
    if line:
        try:
            return int(float(line.split()[0]))
        except (IndexError, ValueError):
            pass
    if _HAS_PSUTIL:
        try:
            return int(time.time() - psutil.boot_time())
        except Exception:  # noqa: BLE001
            return None
    return None


def _read_fan_rpm() -> Optional[int]:
    if not HOST.fan_rpm_path:
        return None
    raw = _read_file(HOST.fan_rpm_path)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _read_fan_state() -> Tuple[Optional[int], Optional[int]]:
    """Return ``(current_state, max_state)`` for the cooling device.

    For a gpio-fan overlay the state is essentially a binary off/on
    (0 = off, 1 = on); for a pwm-fan overlay it's the PWM bucket
    (typically 0..N where N = ``max_state``). The UI computes a percent
    from these two so it doesn't have to care which overlay is in use.
    """
    if not HOST.fan_cooling_path:
        return None, None
    try:
        cur = int((Path(HOST.fan_cooling_path) / "cur_state").read_text().strip())
    except (OSError, ValueError):
        return None, HOST.fan_cooling_max_state
    return cur, HOST.fan_cooling_max_state


# ---------- Rolling I/O deltas (need a previous snapshot to be useful) ----------

@dataclass
class _IoState:
    """Stash of the last counters + timestamp so we can compute rates."""

    ts: float = 0.0
    disk_read_bytes: int = 0
    disk_write_bytes: int = 0
    net_rx_bytes: int = 0
    net_tx_bytes: int = 0
    initialized: bool = False


_io_state: _IoState = _IoState()


def _io_rates() -> Dict[str, Optional[float]]:
    """Compute disk + net rates by diffing against the previous call.

    First call ever returns Nones (no previous sample → no rate). Caller
    is expected to poll on a steady cadence (the UI polls every 5 s), so
    the rate naturally averages over the inter-poll interval.
    """
    out: Dict[str, Optional[float]] = {
        "disk_read_bps": None,
        "disk_write_bps": None,
        "net_rx_bps": None,
        "net_tx_bps": None,
    }
    if not _HAS_PSUTIL:
        return out
    try:
        disk = psutil.disk_io_counters()
        net = psutil.net_io_counters()
    except Exception:  # noqa: BLE001
        return out
    now = time.time()
    if _io_state.initialized:
        dt = now - _io_state.ts
        if dt > 0:
            out["disk_read_bps"] = max(0.0, (disk.read_bytes - _io_state.disk_read_bytes) / dt)
            out["disk_write_bps"] = max(0.0, (disk.write_bytes - _io_state.disk_write_bytes) / dt)
            out["net_rx_bps"] = max(0.0, (net.bytes_recv - _io_state.net_rx_bytes) / dt)
            out["net_tx_bps"] = max(0.0, (net.bytes_sent - _io_state.net_tx_bytes) / dt)
    _io_state.ts = now
    _io_state.disk_read_bytes = disk.read_bytes
    _io_state.disk_write_bytes = disk.write_bytes
    _io_state.net_rx_bytes = net.bytes_recv
    _io_state.net_tx_bytes = net.bytes_sent
    _io_state.initialized = True
    return out


# ---------- Public API ----------

def host_info() -> Dict[str, object]:
    """Static info — model, kernel, totals, what features are available."""
    return {
        "is_raspberry": HOST.is_raspberry,
        "model": HOST.model,
        "kernel": HOST.kernel,
        "ram_total_bytes": HOST.ram_total_bytes,
        "cpu_count": HOST.cpu_count,
        "has_vcgencmd": HOST.has_vcgencmd,
        "fan": {
            "controllable": HOST.fan_cooling_path is not None,
            "max_state": HOST.fan_cooling_max_state,
            "has_rpm": HOST.fan_rpm_path is not None,
            "cooling_path": HOST.fan_cooling_path,
            "rpm_path": HOST.fan_rpm_path,
        },
    }


def snapshot(db_path: Optional[Path] = None) -> Dict[str, object]:
    """One-shot reading of everything the System page needs.

    *db_path* is optional and only used to report the on-disk size of the
    MinerWatch SQLite database. Caller (main.py) passes the configured
    path so we don't hardcode it here.
    """
    out: Dict[str, object] = {
        "ts": int(time.time()),
        "uptime_seconds": _read_uptime_seconds(),
        "load_average": _read_load_average(),
    }

    # CPU
    cpu: Dict[str, object] = {"percent": None, "per_core": None,
                              "freq_mhz": None, "freq_max_mhz": None}
    if _HAS_PSUTIL:
        try:
            # interval=None uses time-since-last-call. With our 5s poll
            # cadence this gives a smooth, accurate utilisation %.
            cpu["percent"] = psutil.cpu_percent(interval=None)
            cpu["per_core"] = psutil.cpu_percent(interval=None, percpu=True)
        except Exception:  # noqa: BLE001
            pass
        try:
            f = psutil.cpu_freq()
            if f:
                cpu["freq_mhz"] = round(f.current, 0) if f.current else None
                cpu["freq_max_mhz"] = round(f.max, 0) if f.max else None
        except Exception:  # noqa: BLE001
            pass
    # Pi firmware reports the *real* throttled-aware frequency. Prefer
    # it over the sysfs scaling-cur value when available.
    pi_freq = _parse_freq(_vcgencmd("measure_clock", "arm"))
    if pi_freq is not None:
        cpu["freq_mhz"] = pi_freq
    out["cpu"] = cpu

    # Memory
    mem: Dict[str, object] = {"used_bytes": None, "total_bytes": None, "percent": None}
    swap: Dict[str, object] = {"used_bytes": None, "total_bytes": None, "percent": None}
    if _HAS_PSUTIL:
        try:
            v = psutil.virtual_memory()
            mem.update(used_bytes=v.used, total_bytes=v.total, percent=v.percent)
        except Exception:  # noqa: BLE001
            pass
        try:
            s = psutil.swap_memory()
            swap.update(used_bytes=s.used, total_bytes=s.total, percent=s.percent)
        except Exception:  # noqa: BLE001
            pass
    out["memory"] = mem
    out["swap"] = swap

    # Disk (root filesystem)
    disk: Dict[str, object] = {"used_bytes": None, "total_bytes": None,
                               "free_bytes": None, "percent": None}
    try:
        usage = shutil.disk_usage("/")
        disk.update(
            used_bytes=usage.used,
            total_bytes=usage.total,
            free_bytes=usage.free,
            percent=round(usage.used / usage.total * 100, 1) if usage.total else None,
        )
    except OSError:
        pass
    out["disk"] = disk

    # Disk + network I/O rates (rolling)
    out["io"] = _io_rates()

    # Temperature (prefer vcgencmd if available — same value as sysfs on
    # the Pi but sometimes more reliable than the thermal_zone read).
    temp = _parse_temp(_vcgencmd("measure_temp"))
    if temp is None:
        temp = _read_cpu_temp_sysfs()
    out["temperature_c"] = temp

    # Pi-specific firmware queries
    out["voltage_core"] = _parse_volts(_vcgencmd("measure_volts", "core"))
    out["throttled"] = _parse_throttled(_vcgencmd("get_throttled"))

    # Fan
    fan_cur, fan_max = _read_fan_state()
    fan_percent: Optional[int] = None
    if fan_cur is not None and fan_max:
        fan_percent = int(round(fan_cur / fan_max * 100))
    out["fan"] = {
        "controllable": HOST.fan_cooling_path is not None,
        "rpm": _read_fan_rpm(),
        "state": fan_cur,
        "max_state": fan_max,
        "percent": fan_percent,
    }

    # MinerWatch DB size (handy for retention tuning)
    db_size: Optional[int] = None
    if db_path is not None:
        try:
            p = Path(db_path)
            if p.exists():
                db_size = p.stat().st_size
        except OSError:
            pass
    out["db_size_bytes"] = db_size

    return out


def set_fan_percent(percent: int) -> Dict[str, object]:
    """Drive the cooling device to ``percent`` (0..100).

    Translates the percent into the nearest ``cur_state`` bucket and
    writes it to sysfs. Raises :class:`RuntimeError` if no controllable
    fan is present so the caller can return a clean 4xx to the UI.

    Note: a gpio-fan overlay only supports two states (off/on); for that
    case any percent > 0 maps to "on" and percent == 0 maps to "off".
    """
    if percent < 0 or percent > 100:
        raise ValueError("percent must be in 0..100")
    if not HOST.fan_cooling_path or not HOST.fan_cooling_max_state:
        raise RuntimeError("no controllable fan detected on this host")

    max_state = HOST.fan_cooling_max_state
    # Round to the nearest bucket. For gpio-fan (max_state=1) this gives
    # 0..50% → off, 51..100% → on, which is intuitive.
    target = int(round(percent / 100 * max_state))
    target = max(0, min(target, max_state))

    cur_path = Path(HOST.fan_cooling_path) / "cur_state"
    try:
        cur_path.write_text(str(target))
    except OSError as exc:
        raise RuntimeError(f"failed to write fan state: {exc}") from exc

    return {
        "ok": True,
        "requested_percent": percent,
        "applied_state": target,
        "max_state": max_state,
        "applied_percent": int(round(target / max_state * 100)),
    }


# ---------- Async convenience for the API layer ----------
#
# The reads are short and synchronous, but we still hop to a worker
# thread so we never block the event loop — vcgencmd in particular can
# stall for up to 1.5 s when the firmware mailbox is busy.

async def snapshot_async(db_path: Optional[Path] = None) -> Dict[str, object]:
    return await asyncio.to_thread(snapshot, db_path)


async def set_fan_percent_async(percent: int) -> Dict[str, object]:
    return await asyncio.to_thread(set_fan_percent, percent)
