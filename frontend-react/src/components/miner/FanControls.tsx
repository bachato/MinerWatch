import { useEffect, useState } from 'react';
import { Fan, Hand, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { ApiError } from '@/lib/api';
import { useSetFan, useSetFanConfig } from '@/api/hooks';
import type { MinerDetailResponse } from '@/lib/types';

interface Props {
  data: MinerDetailResponse;
}

/**
 * Controls tab — fan-only.
 *
 * Frequency and voltage controls are intentionally not surfaced in the
 * vanilla page (commented out in miner.js) because direct overclock /
 * undervolt from the UI is dangerous if used without instrumentation.
 * We keep the same posture here: the capability is reported and the
 * backend endpoints exist, but the UI exposes only fan management.
 */
export function FanControls({ data }: Props) {
  const { miner, capabilities } = data;
  const [target, setTarget] = useState<number>(miner.auto_target_c ?? 65);
  const lastFanPct = data.last_metric?.fan_pct ?? null;
  const initialPct = miner.fan_mode === 'manual' && lastFanPct
    ? Math.round(Number(lastFanPct))
    : 50;
  const [pct, setPct] = useState<number>(initialPct);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setFan = useSetFan(miner.id);
  const setFanConfig = useSetFanConfig(miner.id);

  // Keep slider in sync with backend state on first load / external changes
  useEffect(() => {
    setTarget(miner.auto_target_c ?? 65);
  }, [miner.auto_target_c]);

  if (!capabilities.set_fan) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Write controls are not supported for this miner family. Only the toolbar
          actions (Restart, Remove) are available.
        </CardContent>
      </Card>
    );
  }

  const fanMode = miner.fan_mode ?? 'firmware';

  async function applyManual() {
    setFeedback(null);
    setError(null);
    try {
      await setFanConfig.mutateAsync({ fan_mode: 'manual' });
      await setFan.mutateAsync({ percent: pct });
      setFeedback(`Fan set to ${pct}%`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function enableAuto() {
    setFeedback(null);
    setError(null);
    if (Number.isNaN(target)) {
      setError('Set the target temperature first.');
      return;
    }
    try {
      await setFanConfig.mutateAsync({
        fan_mode: 'minerwatch',
        auto_target_c: target,
      });
      setFeedback(`AUTO enabled — target ${target}°C`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function saveTarget() {
    setFeedback(null);
    setError(null);
    if (Number.isNaN(target)) {
      setError('Invalid target.');
      return;
    }
    try {
      await setFanConfig.mutateAsync({ auto_target_c: target });
      setFeedback(`Target saved: ${target}°C`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  const modeBadge =
    fanMode === 'manual'
      ? { icon: Hand, label: 'Manual', tone: 'outline' as const }
      : fanMode === 'minerwatch'
        ? { icon: Sparkles, label: 'AUTO (MinerWatch)', tone: 'success' as const }
        : { icon: Fan, label: 'AUTO (firmware)', tone: 'secondary' as const };

  const pending = setFan.isPending || setFanConfig.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Fan</CardTitle>
        <Badge variant={modeBadge.tone} className="flex items-center gap-1.5">
          <modeBadge.icon className="h-3 w-3" /> {modeBadge.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm">Manual speed</Label>
            <span className="text-sm font-semibold tabular-nums">{pct}%</span>
          </div>
          <Slider
            value={[pct]}
            min={0}
            max={100}
            step={1}
            disabled={pending}
            onValueChange={(v) => setPct(v[0] ?? pct)}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={applyManual} disabled={pending} className="flex-1 sm:flex-initial">
              Apply
            </Button>
            <Button variant="subtle" onClick={enableAuto} disabled={pending} className="flex-1 sm:flex-initial">
              <Sparkles className="h-4 w-4" /> AUTO
            </Button>
          </div>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <Label htmlFor="auto-target" className="text-sm">
            Target temperature for AUTO (°C)
          </Label>
          <div className="flex gap-2">
            <Input
              id="auto-target"
              type="number"
              min={40}
              max={90}
              step={0.5}
              value={Number.isFinite(target) ? target : ''}
              onChange={(e) => setTarget(Number(e.target.value))}
              disabled={pending}
              className="max-w-[140px]"
            />
            <Button variant="subtle" onClick={saveTarget} disabled={pending}>
              Save target
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Chip hint: BM1370 (Gamma) ~60–65°C · BM1397 ~65–70°C · Avalon Nano 3s ~70–75°C.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Apply</span> = fixed percentage.{' '}
          <span className="font-semibold text-foreground">AUTO</span> = MinerWatch's PID adjusts
          speed every 10 s to hold chip temp near the target. Avalon firmware only accepts
          percentages in 15–100 (below 15 falls back to firmware-auto).
        </p>

        {(feedback || error) && (
          <p className={`text-sm ${error ? 'text-destructive' : 'text-emerald-400'}`} role="status">
            {error ?? feedback}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
