// TypeScript shapes mirroring the FastAPI responses MinerWatch returns.
// Kept in one place because most components touch at least one of them.
// When the backend grows a field, this is the only file that has to
// change to make the new field visible to the entire frontend.
//
// Convention: we annotate optional/nullable fields with `| null` because
// the Python backend returns `null` literally (it doesn't omit keys).

export type MinerFamily = 'bitaxe' | 'nerdoctaxe' | 'canaan' | 'braiins' | 'luxos';

export interface MinerRecord {
  id: number;
  family: MinerFamily;
  host: string;
  port: number | null;
  name: string;
  mac: string | null;
  model: string | null;
  notes: string | null;
  enabled: number;
  fan_mode: 'firmware' | 'manual' | 'minerwatch' | null;
  auto_target_c: number | null;
  fan_min_override: number | null;
  fan_max_override: number | null;
  last_status: string | null;
}

export interface MetricSample {
  ts: number;
  hashrate_ths: number | null;
  power_w: number | null;
  temp_chip_c: number | null;
  temp_vr_c: number | null;
  fan_rpm: number | null;
  fan_pct: number | null;
  frequency_mhz: number | null;
  voltage_mv: number | null;
  uptime_s: number | null;
  accepted: number | null;
  rejected: number | null;
  best_difficulty: number | null;
  pool_url: string | null;
  worker: string | null;
}

// Health status of a single ASIC chip, as reported by the LuxOS
// ``healthchipget`` command. "Y" = healthy, "N" = unhealthy/dead,
// "Unknown" = the firmware hasn't classified this chip yet (e.g. it
// was just powered on or the health check is currently in progress).
export type ChipHealth = 'Y' | 'N' | 'Unknown';

export interface ChipHealthRecord {
  chip: number | null;
  row: number | null;
  column: number | null;
  domain: number | null;
  healthy: ChipHealth;
  is_checking: boolean | null;
  // Optional fields — LuxOS omits these when health == "Unknown".
  frequency: number | null;
  ghs_1m: number | null;
  ghs_5m: number | null;
  ghs_15m: number | null;
  score: number | null;
  // Per-chip temperature is only reported by S21/T21-class firmware.
  chip_temp_c: number | null;
  hash_count: number | null;
  hash_expected: number | null;
}

// Per-hashboard snapshot. ``temps_extra`` is keyed by the LuxOS
// position name (BottomLeft / BottomRight / TopLeft / TopRight) and
// ``temps_labels`` maps the same key to a human-readable label
// ("Board Exhaust", "Board Intake", …) that comes from the METADATA
// section of the ``temps`` reply. Both are empty objects on builds
// that don't expose this metadata; the frontend then falls back to
// rendering the raw position name.
export interface BoardSnapshot {
  id: number;
  status: string | null;
  enabled: boolean | null;
  connector: string | null;
  frequency_mhz: number | null;
  voltage_v: number | null;
  hashrate_ths: number | null;
  hashrate_5s_ths: number | null;
  nominal_ths: number | null;
  temp_chip_c: number | null;
  temps_extra: Record<string, number>;
  temps_labels: Record<string, string>;
  chips_total: number | null;
  chips_healthy: number | null;
  chips_unhealthy: number | null;
  chips_unknown: number | null;
  chips: ChipHealthRecord[];
}

// One physical fan. Today only LuxOS populates this; for other
// families the array stays empty and the frontend falls back to the
// legacy single-fan / fan_2 rendering.
export interface FanSnapshot {
  id: number;
  rpm: number | null;
  speed_pct: number | null;
  connector: string | null;  // e.g. "J12 | J14" — LuxOS only
}

// Live sample shape mirrors backend/miners/base.py:MinerSample as serialised
// by dataclasses.asdict. Most fields overlap with MetricSample; extras
// like `raw` and the air-inlet/outlet temps live only on the live blob.
export interface LiveSample {
  family: MinerFamily;
  host: string;
  online: boolean;
  error: string | null;
  mac: string | null;
  model: string | null;
  hostname: string | null;
  firmware_version: string | null;
  hashrate_ths: number | null;
  power_w: number | null;
  efficiency_w_per_ths: number | null;
  temp_chip_c: number | null;
  temp_vr_c: number | null;
  temp_outlet_c: number | null;
  temp_inlet_c: number | null;
  temp_avg_c: number | null;
  fan_rpm: number | null;
  fan_pct: number | null;
  fans_extra: Record<string, number>;
  // Structured per-fan list (LuxOS only at the moment). When present
  // the frontend renders one tile per fan with RPM/% and the connector
  // label; otherwise it falls back to the legacy single-fan rendering.
  fans: FanSnapshot[];
  // NerdOctaxe-only: the firmware exposes a second physical fan.
  // Stay null on Bitaxe and on the cgminer families.
  fan_rpm_2: number | null;
  fan_pct_2: number | null;
  frequency_mhz: number | null;
  voltage_mv: number | null;
  asic_count: number | null;
  // Multi-hashboard miners report one entry per physical board plus
  // the totals. ``board_count`` and ``chip_count`` separate the two
  // concepts that ``asic_count`` historically conflated.
  board_count: number | null;
  chip_count: number | null;
  boards: BoardSnapshot[];
  // PSU draw in Amps. Populated by the NerdOctaxe driver from the
  // firmware's `currentA` field; null elsewhere.
  current_a: number | null;
  // Aggregate "hardware error" counter — count of nonces the ASIC
  // returned that failed validation. NerdOctaxe firmware emits this
  // as `duplicateHWNonces`. Bitaxe doesn't surface it, so null there.
  hw_errors: number | null;
  uptime_s: number | null;
  accepted: number | null;
  rejected: number | null;
  best_difficulty: number | null;
  best_difficulty_alltime: number | null;
  network_difficulty: number | null;
  pool_url: string | null;
  worker: string | null;
  // Dual-pool fields (NerdOctaxe firmware). `pool_active` is
  // "primary" | "fallback" when the firmware tells us which one is
  // currently mining, or null otherwise.
  pool_url_fallback: string | null;
  worker_fallback: string | null;
  pool_active: 'primary' | 'fallback' | string | null;
  raw: Record<string, unknown> | null;
}

export interface MinerListEntry extends MinerRecord {
  last_metric: MetricSample | null;
  live_online: boolean | null;
  live_error: string | null;
}

export interface MinerListResponse {
  miners: MinerListEntry[];
}

export interface Capabilities {
  set_fan: boolean;
  set_frequency: boolean;
  set_voltage: boolean;
  restart: boolean;
}

export interface MinerDetailResponse {
  miner: MinerRecord;
  last_metric: MetricSample | null;
  live_sample: LiveSample | null;
  capabilities: Capabilities;
}

export interface BestRecord {
  miner_id: number;
  miner_name: string;
  value: number;
  ts: number;
}

export interface BestRecordsResponse {
  session: BestRecord | null;
  alltime: BestRecord | null;
}

export interface BestRecordRanked {
  miner_id: number;
  miner_name: string;
  family: MinerFamily;
  value: number;
  ts: number;
}

export interface BestRecordsTopResponse {
  scope: 'session' | 'alltime';
  limit: number;
  entries: BestRecordRanked[];
}

export interface PredictionWindow {
  expected_time_s: number | null;
  probability: {
    '1h': number;
    '24h': number;
    '7d': number;
  };
}

export interface PredictionResponse {
  fleet_hashrate_ths: number | null;
  best_alltime: BestRecord | null;
  network_difficulty: number | null;
  predictions: {
    beat_best: PredictionWindow | null;
    find_block: PredictionWindow | null;
  };
}

export interface BlockFind {
  miner_id: number;
  miner_name: string;
  ts: number;
  share_difficulty: number;
  network_difficulty: number;
  block_height: number | null;
}

export interface BlockFindsResponse {
  block_finds: BlockFind[];
}

// The backend returns one row per bucket as { bucket_ts, total_ths }.
// We keep the names backend-exact so a stray rename here is loud
// rather than silently producing an empty chart.
export interface FleetHashratePoint {
  bucket_ts: number;
  total_ths: number;
}

export interface FleetHashrateResponse {
  from_ts: number;
  to_ts: number;
  bucket_seconds: number;
  points: FleetHashratePoint[];
}

export interface MetricsRangeResponse {
  miner_id: number;
  from_ts: number;
  to_ts: number;
  tier: 'raw' | '1m' | '1h';
  metrics: MetricSample[];
}

export interface AuthStatus {
  enabled: boolean;
  authenticated?: boolean;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}

// Subset of /api/settings we actually read from the frontend. The
// endpoint returns more fields (auth subset, telegram_token_set, …)
// but the dashboard only needs polling cadence + temperature limits
// to render the toolbar subtitle and the critical-temperature banner.
export interface SettingsCurrent {
  polling: {
    interval_seconds: number;
    request_timeout: number;
    hashrate_smoothing_seconds: number;
  };
  alerts: {
    temp_chip_threshold: number;
    temp_vr_threshold: number;
    offline_threshold_seconds: number;
    repeat_seconds: number;
    notifications_enabled: boolean;
    push_enabled: boolean;
    telegram_enabled: boolean;
    telegram_chat_id?: string | null;
    telegram_token_set?: boolean;
  };
  storage: {
    retention_raw_hours: number;
    retention_1m_days: number;
    retention_1h_days: number;
  };
  network: {
    scan_cidr: string;
    scan_timeout: number;
  };
  auth_enabled: boolean;
}

export interface SettingsResponse {
  current: SettingsCurrent;
  stored: Record<string, string>;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertCode = 'temp_chip' | 'temp_vr' | 'offline' | 'recovered' | string;

export interface AlertEntry {
  id: number;
  miner_id: number | null;
  ts: number;
  severity: AlertSeverity;
  code: AlertCode;
  message: string;
  acknowledged: number; // 0 | 1 (SQLite int)
}

export interface AlertsResponse {
  alerts: AlertEntry[];
}

export interface MinerCreatePayload {
  family: MinerFamily;
  host: string;
  port?: number | null;
  name?: string | null;
  notes?: string | null;
}

export interface DiscoveryFound {
  family: MinerFamily;
  host: string;
  port: number;
  mac: string | null;
  name: string;
  added: boolean;
  reason?: string;
}

export interface DiscoveryResponse {
  registered: number;
  miners: DiscoveryFound[];
}

export interface TelegramChat {
  chat_id: string;
  label: string;
  type: string;
}

export interface TelegramDiscoverResponse {
  chats: TelegramChat[];
}

export interface PushTestResponse {
  subscribers: number;
}

// Host metrics surfaced by /api/system/info and /api/system/snapshot.
// The shapes here mirror backend/system_info.py exactly: when in doubt
// match the Python keys 1:1 rather than re-flattening, because the
// backend returns nested groups (cpu/memory/disk/fan/throttled) and
// every divergence is a silent rendering bug.

export interface SystemInfo {
  is_raspberry: boolean;
  model: string | null;
  kernel: string | null;
  ram_total_bytes: number | null;
  cpu_count: number | null;
  has_vcgencmd: boolean;
  fan: {
    controllable: boolean;
    max_state: number | null;
    has_rpm: boolean;
    cooling_path: string | null;
    rpm_path: string | null;
  };
}

export interface SystemCpu {
  percent: number | null;
  per_core: number[] | null;
  freq_mhz: number | null;
  freq_max_mhz: number | null;
}

export interface SystemMemory {
  used_bytes: number | null;
  total_bytes: number | null;
  percent: number | null;
}

export interface SystemDisk {
  used_bytes: number | null;
  total_bytes: number | null;
  free_bytes: number | null;
  percent: number | null;
}

export interface SystemThrottled {
  raw: string | null;
  now_undervoltage: boolean | null;
  now_freq_capped: boolean | null;
  now_throttled: boolean | null;
  now_soft_temp_limit: boolean | null;
  ever_undervoltage: boolean | null;
  ever_freq_capped: boolean | null;
  ever_throttled: boolean | null;
  ever_soft_temp_limit: boolean | null;
}

export interface SystemFanSnapshot {
  controllable: boolean;
  rpm: number | null;
  state: number | null;
  max_state: number | null;
  percent: number | null;
}

export interface SystemSnapshot {
  ts: number;
  uptime_seconds: number | null;
  load_average: [number, number, number] | null;
  cpu: SystemCpu;
  memory: SystemMemory;
  swap: SystemMemory;
  disk: SystemDisk;
  temperature_c: number | null;
  voltage_core: number | null;
  throttled: SystemThrottled;
  fan: SystemFanSnapshot;
  db_size_bytes: number | null;
}

// ----- Self-update (/api/version, /api/update/check, /api/update/install)

export interface VersionResponse {
  version: string;
  system: {
    os: string; // Darwin | Linux | Windows
    os_release: string;
    machine: string;
    python: string;
  };
}

export interface UpdateCheckResponse {
  current: string;
  latest: string | null;
  available: boolean;
  release_notes_url: string | null;
  release_name: string | null;
  published_at: string | null;
  asset_url: string | null;
  asset_name: string | null;
  asset_size: number | null;
  sha256: string | null;
  requires_service_reinstall: boolean;
  error: string | null;
  checked_at: number;
}

export interface UpdateInstallResponse {
  status: 'restarting';
  previous_version: string;
  new_version: string;
  requires_service_reinstall: boolean;
}
