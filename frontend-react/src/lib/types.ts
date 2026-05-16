// TypeScript shapes mirroring the FastAPI responses MinerWatch returns.
// Kept in one place because most components touch at least one of them.
// When the backend grows a field, this is the only file that has to
// change to make the new field visible to the entire frontend.
//
// Convention: we annotate optional/nullable fields with `| null` because
// the Python backend returns `null` literally (it doesn't omit keys).

export type MinerFamily = 'bitaxe' | 'canaan' | 'braiins';

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
  frequency_mhz: number | null;
  voltage_mv: number | null;
  asic_count: number | null;
  uptime_s: number | null;
  accepted: number | null;
  rejected: number | null;
  best_difficulty: number | null;
  best_difficulty_alltime: number | null;
  network_difficulty: number | null;
  pool_url: string | null;
  worker: string | null;
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

export interface FleetHashratePoint {
  ts: number;
  hashrate_ths: number;
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
