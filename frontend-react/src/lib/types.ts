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
  authenticated: boolean;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}
