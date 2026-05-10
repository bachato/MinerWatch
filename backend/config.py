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
FRONTEND_DIR = ROOT_DIR / "frontend"


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
    # Global kill-switch for push notifications. When False, send_push()
    # returns immediately without sending anything, regardless of the
    # registered subscriptions. It's a clean "do not disturb": subs aren't touched.
    notifications_enabled: bool = True


@dataclass
class AuthCfg:
    enabled: bool = False
    password: str = ""


@dataclass
class Config:
    server: ServerCfg = field(default_factory=ServerCfg)
    network: NetworkCfg = field(default_factory=NetworkCfg)
    polling: PollingCfg = field(default_factory=PollingCfg)
    storage: StorageCfg = field(default_factory=StorageCfg)
    alerts: AlertsCfg = field(default_factory=AlertsCfg)
    auth: AuthCfg = field(default_factory=AuthCfg)

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
