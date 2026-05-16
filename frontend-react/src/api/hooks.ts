import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type {
  AuthStatus,
  BestRecordsResponse,
  BestRecordsTopResponse,
  BlockFindsResponse,
  FleetHashrateResponse,
  MetricsRangeResponse,
  MinerDetailResponse,
  MinerListResponse,
  PredictionResponse,
} from '@/lib/types';

// React Query hooks wrapping the /api endpoints MinerWatch exposes.
// Every hook owns its own polling cadence; if a screen mounts the same
// hook twice (e.g. a sidebar and a panel both reading the miner list)
// Query dedupes the network call automatically — that's the whole
// point of moving away from manual setInterval-based polling.
//
// Standard refetch is 5s, matching the backend poller cadence. Pages
// that don't need that frequency (Settings, Login) won't mount these.

const FIVE_SECONDS = 5_000;

export function useMiners() {
  return useQuery({
    queryKey: ['miners'],
    queryFn: ({ signal }) => api<MinerListResponse>('/api/miners', { signal }),
    refetchInterval: FIVE_SECONDS,
  });
}

export function useMiner(id: number | undefined) {
  return useQuery({
    enabled: Number.isInteger(id),
    queryKey: ['miner', id],
    queryFn: ({ signal }) =>
      api<MinerDetailResponse>(`/api/miners/${id}`, { signal }),
    refetchInterval: FIVE_SECONDS,
  });
}

export function useMinerMetrics(id: number | undefined, fromTs: number, toTs: number) {
  return useQuery({
    enabled: Number.isInteger(id) && fromTs < toTs,
    queryKey: ['miner-metrics', id, fromTs, toTs],
    queryFn: ({ signal }) =>
      api<MetricsRangeResponse>(
        `/api/miners/${id}/metrics?from_ts=${fromTs}&to_ts=${toTs}`,
        { signal },
      ),
    // Metric ranges are bigger payloads (up to 30 days of 1-min rollups)
    // so we keep them around longer than fleet polling.
    staleTime: 60_000,
  });
}

export function useFleetHashrate(minutes = 60, bucketSeconds = 60) {
  return useQuery({
    queryKey: ['fleet-hashrate', minutes, bucketSeconds],
    queryFn: ({ signal }) =>
      api<FleetHashrateResponse>(
        `/api/fleet/hashrate_history?minutes=${minutes}&bucket_seconds=${bucketSeconds}`,
        { signal },
      ),
    refetchInterval: FIVE_SECONDS,
  });
}

export function useFleetBest() {
  return useQuery({
    queryKey: ['fleet-best'],
    queryFn: ({ signal }) =>
      api<BestRecordsResponse>('/api/fleet/best_difficulty', { signal }),
    refetchInterval: FIVE_SECONDS,
  });
}

export function useFleetBestTop(scope: 'session' | 'alltime' = 'alltime', limit = 10) {
  return useQuery({
    queryKey: ['fleet-best-top', scope, limit],
    queryFn: ({ signal }) =>
      api<BestRecordsTopResponse>(
        `/api/fleet/best_difficulty/top?scope=${scope}&limit=${limit}`,
        { signal },
      ),
    refetchInterval: FIVE_SECONDS,
  });
}

export function useFleetPrediction() {
  return useQuery({
    queryKey: ['fleet-prediction'],
    queryFn: ({ signal }) =>
      api<PredictionResponse>('/api/fleet/prediction', { signal }),
    refetchInterval: FIVE_SECONDS,
  });
}

export function useBlockFinds() {
  return useQuery({
    queryKey: ['block-finds'],
    queryFn: ({ signal }) =>
      api<BlockFindsResponse>('/api/fleet/block_finds', { signal }),
    refetchInterval: 30_000, // block finds are rare, no need to hammer
  });
}

export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth-status'],
    queryFn: ({ signal }) => api<AuthStatus>('/api/auth/status', { signal }),
    staleTime: Infinity, // doesn't change without user action
  });
}
