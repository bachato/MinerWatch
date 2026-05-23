# SPDX-License-Identifier: AGPL-3.0-only
"""MinerWatch configuration loading and management.

Precedence order:
  1. Runtime overrides stored in the DB (`settings` table)
  2. config.yaml (if present in the repo root)
  3. config.example.yaml (default)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
# FRONTEND_DIR points at the React bundle Vite emits. The legacy
# vanilla frontend at ./frontend/ was retired in P1 session 5; if you
# need to recover one of its files, check git history before the
# session-5 commit.
FRONTEND_DIR = ROOT_DIR / "frontend-react" / "dist"


@dataclass
class ServerCfg:
    host: str = "0.0.0.0"
    port: int = 8000


@dataclass
class NetworkCfg:
    scan_cidr: str = "auto"
    scan_timeout: float = 0.4


@dataclass
class PollingCfg:
    interval_seconds: int = 5
    request_timeout: int = 4
    # Time constant (tau) for the EMA used to smooth hashrate before
    # exposing/persisting it. 60s = good trade-off between responsiveness
    # and stability on stochastic miners (Poisson). 0 = disable smoothing (raw).
    hashrate_smoothing_seconds: int = 60


@dataclass
class StorageCfg:
    # Tiered retention: each tier is a separate aggregation level kept
    # for a different amount of time. The poller aggregates raw 5s
    # samples into 1-minute and 1-hour rollup tables, then prunes each
    # table according to its own retention.
    #
    # `retention_days` is kept for backward compatibility — older
    # config files set only this knob. When it's the only value
    # provided, we map it onto `retention_1m_days` (the "main" tier
    # users mostly look at).
    retention_raw_hours: int = 48
    retention_1m_days: int = 30
    retention_1h_days: int = 730
    retention_days: int = 30  # deprecated alias for retention_1m_days


@dataclass
class AlertsCfg:
    temp_chip_threshold: float = 75.0
    temp_vr_threshold: float = 90.0
    offline_threshold_seconds: int = 60
    # If a threshold is still exceeded N seconds after the first alert,
    # we emit another one (and another push). Default: 10 min.
    repeat_seconds: int = 600
    # Global kill-switch for ALL notifications (every channel). When False,
    # the notification dispatcher returns immediately. Subscriptions and
    # tokens are kept untouched, so re-enabling restores delivery without
    # any further action from the user. It's a clean "do not disturb".
    notifications_enabled: bool = True
    # Per-channel toggles. Browser push works only in secure contexts
    # (https or localhost) — useless on a LAN IP from an iPhone. The
    # Telegram channel covers exactly that gap: it's an outbound HTTP
    # POST from the server, so it works regardless of how the user
    # reaches the dashboard.
    push_enabled: bool = True
    telegram_enabled: bool = False
    telegram_bot_token: str = ""
    # String (not int) so it transparently supports group chats whose
    # IDs are negative numbers like "-1001234567890".
    telegram_chat_id: str = ""


@dataclass
class AuthCfg:
    enabled: bool = False
    password: str = ""


@dataclass
class TunerCfg:
    """Configuration for the efficiency/performance tuner.

    The tuner is an *opt-out* bolt-on feature: it finds the best
    frequency/coreVoltage pair for a chosen profile (Performance or Eco)
    by sweeping settings while the existing server-side auto-fan PID
    holds the chip at the profile's target temperature. See
    ``docs/tuner-design.md`` for the full design.

    ``enabled`` is the feature flag. Flip it to False to hide the whole
    feature (the API endpoints 404 and the UI tab disappears) without
    removing any code.

    ``profiles`` is a plain dict (not a nested dataclass) so it can be
    overridden wholesale from config.yaml without fighting the flat
    dotted-key override mechanism in :meth:`Config.apply_overrides`.
    Each profile carries:
      - ``target_c``    : chip-temp setpoint the auto-fan PID holds
      - ``fan_cap_pct`` : max fan duty (maps to fan_max_override)
      - ``k_temp``      : penalty weight for exceeding target
      - ``w_fan``       : penalty weight for fan noise (fan %)
      - ``m_eff``       : penalty weight for poor efficiency (J/TH)
    Values locked with the user: Performance 62 °C / fan 100 %,
    Eco 58 °C / fan 90 %.
    """

    enabled: bool = True

    # ---- Hard safety cutoffs: abort the current test point if crossed.
    # These sit BELOW the global 75 °C auto-fan watchdog on purpose, so
    # the tuner stops before the watchdog ever has to intervene.
    cutoff_chip_c: float = 67.0
    cutoff_vr_c: float = 85.0
    input_voltage_min_mv: int = 4800
    input_voltage_max_mv: int = 5500

    # ---- Per-family PSU power ceilings (W). AxeOS doesn't expose a max,
    # so these are conservative guards; tune to your own power supply.
    power_ceiling_bitaxe_w: float = 40.0
    power_ceiling_nerdoctaxe_w: float = 160.0

    # ---- Search space (clamped to whatever /api/system/asic reports).
    voltage_floor_mv: int = 1000
    voltage_ceiling_mv: int = 1300
    voltage_step_mv: int = 10
    frequency_floor_mhz: int = 400
    frequency_ceiling_mhz: int = 700
    frequency_step_mhz: int = 25
    # v2 stability gate — primary signal: a real HW error PERCENTAGE
    # (errorCount / total work over the sampling window, ×100). Single value
    # for both profiles (stability is a safety standard, not a profile
    # flavour). Default 0.6 % — the level users typically find "satisfying".
    hw_error_pct_max: float = 0.6
    # Secondary gate, used when the firmware exposes an error counter but no
    # usable work denominator (e.g. Nerd* `duplicateHWNonces`): error RATE in
    # errors/min. Tune from the results table — magnitudes vary by chip.
    hw_error_rate_max_per_min: float = 5.0
    # Last-resort gate, used only when no error counter is available at all:
    # a point is stable if measured hashrate >= this fraction of the per-chip
    # expected hashrate (auto-calibrated from the baseline).
    stability_fraction: float = 0.90
    max_points: int = 40

    # ---- Timing for the "thorough" (Accurata) profile, in seconds.
    post_restart_wait_s: int = 90
    settle_max_s_bitaxe: int = 180
    settle_max_s_nerdoctaxe: int = 480
    sample_window_s: int = 600
    sample_interval_s: int = 15
    min_samples: int = 7
    warmup_samples: int = 6
    outlier_trim: int = 3

    # Quick-probe params: while searching the minimum stable voltage at a
    # frequency, undervolt instability shows up in the HW error rate within
    # seconds — so each ladder step uses a SHORT window, and only the chosen
    # voltage gets one full-window measurement for accurate hashrate/eff.
    # This makes the per-frequency voltage ladder roughly 4x faster.
    probe_window_s: int = 90
    probe_settle_max_s: int = 60
    probe_warmup_samples: int = 1
    probe_min_samples: int = 3

    profiles: dict = field(
        default_factory=lambda: {
            "performance": {
                "label": "Performance",
                "target_c": 62.0,
                "fan_cap_pct": 100,
                "k_temp": 0.5,
                "w_fan": 0.0,
                "m_eff": 0.2,
                # Sweep starts here, relative to the miner's CURRENT settings:
                # Performance begins just below stock and climbs.
                "start_freq_offset_mhz": -50,
                "start_volt_offset_mv": -100,
            },
            "eco": {
                "label": "Eco / Cool",
                "target_c": 58.0,
                "fan_cap_pct": 90,
                "k_temp": 2.0,
                "w_fan": 0.5,
                "m_eff": 1.0,
                # Eco explores lower for efficiency, so it starts further
                # below stock — and its voltage starts lower too, otherwise
                # it would sit above the (low) Vmin and skip the efficient zone.
                "start_freq_offset_mhz": -150,
                "start_volt_offset_mv": -180,
            },
        }
    )


@dataclass
class Config:
    server: ServerCfg = field(default_factory=ServerCfg)
    network: NetworkCfg = field(default_factory=NetworkCfg)
    polling: PollingCfg = field(default_factory=PollingCfg)
    storage: StorageCfg = field(default_factory=StorageCfg)
    alerts: AlertsCfg = field(default_factory=AlertsCfg)
    auth: AuthCfg = field(default_factory=AuthCfg)
    tuner: TunerCfg = field(default_factory=TunerCfg)

    @classmethod
    def load(cls) -> "Config":
        candidates = [ROOT_DIR / "config.yaml", ROOT_DIR / "config.example.yaml"]
        raw: dict[str, Any] = {}
        for path in candidates:
            if path.exists():
                with path.open("r", encoding="utf-8") as fp:
                    raw = yaml.safe_load(fp) or {}
                break
        return cls(
            server=ServerCfg(**raw.get("server", {})),
            network=NetworkCfg(**raw.get("network", {})),
            polling=PollingCfg(**raw.get("polling", {})),
            storage=StorageCfg(**raw.get("storage", {})),
            alerts=AlertsCfg(**raw.get("alerts", {})),
            auth=AuthCfg(**raw.get("auth", {})),
            tuner=TunerCfg(**raw.get("tuner", {})),
        )

    def apply_overrides(self, overrides: dict[str, Any]) -> None:
        """Apply overrides read from the DB (runtime settings)."""
        applied: set[str] = set()
        for key, value in overrides.items():
            if "." not in key:
                continue
            section, field_name = key.split(".", 1)
            section_obj = getattr(self, section, None)
            if section_obj is None:
                continue
            if not hasattr(section_obj, field_name):
                continue
            current = getattr(section_obj, field_name)
            try:
                if isinstance(current, bool):
                    coerced = str(value).lower() in {"1", "true", "yes", "on"}
                elif isinstance(current, int) and not isinstance(current, bool):
                    coerced = int(value)
                elif isinstance(current, float):
                    coerced = float(value)
                else:
                    coerced = value
                setattr(section_obj, field_name, coerced)
                applied.add(key)
            except (TypeError, ValueError):
                continue

        # Backward compat: if the legacy `storage.retention_days` was the
        # only retention knob set, mirror it onto the new 1m tier so the
        # user's existing setting keeps having the effect they expect.
        if (
            "storage.retention_days" in applied
            and "storage.retention_1m_days" not in applied
        ):
            self.storage.retention_1m_days = int(self.storage.retention_days)


_config: Config | None = None


def get_config() -> Config:
    global _config
    if _config is None:
        DATA_DIR.mkdir(exist_ok=True)
        _config = Config.load()
    return _config


def reload_config() -> Config:
    global _config
    _config = None
    return get_config()


# Path helpers
def db_path() -> Path:
    return DATA_DIR / "minerwatch.db"


def vapid_keys_path() -> Path:
    return DATA_DIR / "vapid_keys.json"
