import { useEffect, useState } from 'react';
import { Activity, Gauge, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ApiError } from '@/lib/api';
import { useGuardianStatus, useSetGuardianConfig } from '@/api/hooks';
import type { MinerDetailResponse } from '@/lib/types';

interface Props {
  data: MinerDetailResponse;
}

/**
 * Advanced tab — the Guardian (runtime frequency governor).
 *
 * The Guardian is a slow, always-on loop that nudges ASIC frequency to keep
 * the VR temperature and HW error rate inside safe bounds, never above a
 * per-miner "max frequency" ceiling (default: the current frequency). It is
 * frequency-only in v1. This panel is the per-miner opt-in + the editable
 * ceiling/floor, plus a live readout of the loop's last decision.
 */
export function GuardianPanel({ data }: Props) {
  const { miner, capabilities } = data;
  const status = useGuardianStatus(miner.id);
  const setConfig = useSetGuardianConfig(miner.id);

  const s = status.data;
  const currentFreq = s?.current_freq_mhz ?? null;

  // The "max frequency" field. Seeded from the stored ceiling, falling back
  // to the live current frequency (what it would default to on first enable).
  const [maxFreq, setMaxFreq] = useState<number | ''>('');
  const [floor, setFloor] = useState<number | ''>('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sync the editable fields when the backend state arrives / changes.
  useEffect(() => {
    if (!s) return;
    setMaxFreq(s.max_freq_mhz ?? s.current_freq_mhz ?? '');
    setFloor(s.freq_floor_mhz ?? '');
  }, [s?.max_freq_mhz, s?.freq_floor_mhz, s?.current_freq_mhz]);

  if (!capabilities.set_frequency) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          The Guardian controls ASIC frequency, which this miner family does
          not expose over the API. It is available on Bitaxe and Nerd* miners.
        </CardContent>
      </Card>
    );
  }

  if (status.isLoading || !s) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Loading Guardian status…
        </CardContent>
      </Card>
    );
  }

  if (!s.supported) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          The Guardian is only supported on Bitaxe / Nerd* miners.
        </CardContent>
      </Card>
    );
  }

  if (!s.enabled) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          The Guardian feature is disabled globally (guardian.enabled = false).
        </CardContent>
      </Card>
    );
  }

  const enabled = s.miner_enabled;
  const d = s.defaults;
  const pending = setConfig.isPending;

  async function run(payload: {
    enabled?: boolean;
    max_freq_mhz?: number;
    freq_floor_mhz?: number;
  }, ok: string) {
    setFeedback(null);
    setError(null);
    try {
      await setConfig.mutateAsync(payload);
      setFeedback(ok);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function toggleEnabled(next: boolean) {
    // When enabling, capture the max-frequency field so the ceiling is set
    // explicitly (the backend would otherwise default it to the current freq).
    const payload: { enabled: boolean; max_freq_mhz?: number } = { enabled: next };
    if (next && typeof maxFreq === 'number' && Number.isFinite(maxFreq)) {
      payload.max_freq_mhz = maxFreq;
    }
    await run(payload, next ? 'Guardian enabled' : 'Guardian disabled');
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4" /> Guardian
        </CardTitle>
        <Badge
          variant={enabled ? 'success' : 'secondary'}
          className="flex items-center gap-1.5"
        >
          <Activity className="h-3 w-3" /> {enabled ? 'Active' : 'Off'}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* What it does */}
        <p className="text-sm text-muted-foreground">
          A slow, always-on governor that adapts ASIC <strong>frequency</strong>{' '}
          to the heat. It backs off when the VR runs hot or errors climb, and
          recovers frequency when things cool — never going above your max.
          Ideal for summer, when ambient swings within a single day.
        </p>

        {/* Enable toggle */}
        <div className="flex items-center justify-between border-t border-border pt-4">
          <div className="space-y-0.5">
            <Label className="text-sm">Enable Guardian on this miner</Label>
            <p className="text-xs text-muted-foreground">
              Re-evaluates every {d.interval_seconds}s. Changes apply live (no
              reboot).
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={pending}
            onCheckedChange={toggleEnabled}
          />
        </div>

        {/* Max frequency (editable ceiling) */}
        <div className="space-y-2 border-t border-border pt-4">
          <Label htmlFor="guardian-max" className="text-sm">
            Max frequency (MHz)
          </Label>
          <div className="flex gap-2">
            <Input
              id="guardian-max"
              type="number"
              min={100}
              max={2000}
              step={5}
              value={maxFreq}
              onChange={(e) =>
                setMaxFreq(e.target.value === '' ? '' : Number(e.target.value))
              }
              disabled={pending}
              className="max-w-[140px]"
            />
            <Button
              variant="subtle"
              disabled={pending || maxFreq === ''}
              onClick={() =>
                typeof maxFreq === 'number' &&
                run({ max_freq_mhz: maxFreq }, `Max frequency set to ${maxFreq} MHz`)
              }
            >
              Save max
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The ceiling the Guardian never exceeds. Defaults to the current
            frequency
            {currentFreq != null ? ` (${currentFreq} MHz)` : ''}; raise it only
            if you know your hardware sustains it.
          </p>
        </div>

        {/* Frequency floor (optional override) */}
        <div className="space-y-2 border-t border-border pt-4">
          <Label htmlFor="guardian-floor" className="text-sm">
            Frequency floor (MHz)
          </Label>
          <div className="flex gap-2">
            <Input
              id="guardian-floor"
              type="number"
              min={100}
              max={2000}
              step={5}
              value={floor}
              placeholder={String(d.frequency_floor_mhz)}
              onChange={(e) =>
                setFloor(e.target.value === '' ? '' : Number(e.target.value))
              }
              disabled={pending}
              className="max-w-[140px]"
            />
            <Button
              variant="subtle"
              disabled={pending || floor === ''}
              onClick={() =>
                typeof floor === 'number' &&
                run({ freq_floor_mhz: floor }, `Floor set to ${floor} MHz`)
              }
            >
              Save floor
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The Guardian never throttles below this. Leave empty to use the
            global default ({d.frequency_floor_mhz} MHz).
          </p>
        </div>

        {/* Policy summary */}
        <div className="space-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">Policy</p>
          <p>
            VR &gt; {d.vr_high_c}°C → −{d.step_down_vr_mhz} MHz · Rejected shares
            &gt; {d.reject_pct_max}% → −{d.step_down_err_mhz} MHz · VR &lt;{' '}
            {d.vr_low_c}°C → +{d.step_up_mhz} MHz (up to your max). Otherwise it
            holds.
          </p>
        </div>

        {/* Live readout */}
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-semibold">Live</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <Stat label="Frequency" value={fmt(s.live?.frequency_mhz ?? currentFreq, 'MHz')} />
            <Stat label="VR temp" value={fmt(s.live?.vr_temp_c ?? null, '°C')} />
            <Stat label="Reject" value={fmt(s.live?.reject_pct ?? null, '%')} />
            <Stat label="Ceiling" value={fmt(s.live?.ceiling_mhz ?? s.max_freq_mhz, 'MHz')} />
            <Stat label="Floor" value={fmt(s.live?.floor_mhz ?? s.freq_floor_mhz, 'MHz')} />
          </div>
          {s.live?.reason && (
            <p className="text-xs text-muted-foreground">
              Last decision: {s.live.reason}
            </p>
          )}
          {!s.live && enabled && (
            <p className="text-xs text-muted-foreground">
              Waiting for the first evaluation…
            </p>
          )}
        </div>

        {/* Risk note */}
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200/90">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The Guardian changes your miner's frequency automatically. It only
            ever lowers below — and recovers up to — your max, and the 75°C
            overheat watchdog stays armed underneath it. Still, run it at your
            own risk and keep an eye on the miner, especially right after
            enabling.
          </span>
        </div>

        {(feedback || error) && (
          <p
            className={`text-sm ${error ? 'text-destructive' : 'text-emerald-400'}`}
            role="status"
          >
            {error ?? feedback}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function fmt(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v} ${unit}`;
}
