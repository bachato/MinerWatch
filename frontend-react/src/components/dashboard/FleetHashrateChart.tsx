import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fmtNum } from '@/lib/format';
import { useFleetHashrate } from '@/api/hooks';

/**
 * Fleet-wide total hashrate chart with a timeframe selector. The
 * underlying endpoint auto-routes between the raw / 1m / 1h tiers
 * based on the requested window, so the user can scroll through
 * "last hour" all the way out to "last 30 days" without the chart
 * dragging the database.
 *
 * Each preset pairs ``minutes`` (the range) with ``bucketSeconds``
 * (the resolution) so we never ask the backend for 30 days of
 * 1-minute samples. Roughly:
 *   1h   → 60 points  at 1-min resolution
 *   6h   → 72 points  at 5-min resolution
 *   24h  → 96 points  at 15-min resolution
 *   7d   → 168 points at 1-hour resolution
 *   30d  → 120 points at 6-hour resolution
 */

interface TimeframePreset {
  id: '1h' | '6h' | '24h' | '7d' | '30d';
  label: string;
  minutes: number;
  bucketSeconds: number;
  /** Sub-title under the card title, e.g. "5-minute average · last 6 hours". */
  caption: string;
}

const PRESETS: TimeframePreset[] = [
  { id: '1h', label: '1h', minutes: 60, bucketSeconds: 60, caption: '1-minute average · last hour' },
  { id: '6h', label: '6h', minutes: 6 * 60, bucketSeconds: 5 * 60, caption: '5-minute average · last 6 hours' },
  { id: '24h', label: '24h', minutes: 24 * 60, bucketSeconds: 15 * 60, caption: '15-minute average · last 24 hours' },
  { id: '7d', label: '7d', minutes: 7 * 24 * 60, bucketSeconds: 3600, caption: '1-hour average · last 7 days' },
  { id: '30d', label: '30d', minutes: 30 * 24 * 60, bucketSeconds: 6 * 3600, caption: '6-hour average · last 30 days' },
];

const DEFAULT_PRESET: TimeframePreset['id'] = '1h';

function formatTick(ts: number, presetId: TimeframePreset['id']): string {
  const d = new Date(ts);
  // Short windows: clock only. Long windows: date only. Medium: both.
  if (presetId === '1h' || presetId === '6h') {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (presetId === '24h') {
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  }
  // 7d / 30d → "dd/mm"
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function FleetHashrateChart() {
  const [presetId, setPresetId] = useState<TimeframePreset['id']>(DEFAULT_PRESET);
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];

  const { data, isLoading } = useFleetHashrate(preset.minutes, preset.bucketSeconds);

  // Backend rows: { bucket_ts, total_ths }. We rename + convert to ms
  // so Recharts can use the standard time-series shape internally.
  const series = useMemo(() => {
    const points = data?.points ?? [];
    return points.map((p) => ({
      ts: p.bucket_ts * 1000,
      ths: p.total_ths,
    }));
  }, [data]);

  const currentTHs = series.length ? series[series.length - 1].ths : null;

  if (isLoading && !series.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fleet total hashrate</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-base">Fleet total hashrate</CardTitle>
          <p className="text-xs text-muted-foreground">{preset.caption}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums text-primary">
              {fmtNum(currentTHs, 2)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">TH/s</span>
            </div>
          </div>
          {/* Timeframe selector. Compact segmented control so it fits
              the card header on mobile. Buttons render as the same
              shape as TabsList/TabsTrigger to stay visually consistent
              with the rest of the app. */}
          <div
            role="tablist"
            aria-label="Hashrate timeframe"
            className="inline-flex h-8 items-center rounded-lg border border-border bg-card p-0.5 text-xs"
          >
            {PRESETS.map((p) => {
              const active = p.id === presetId;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setPresetId(p.id)}
                  className={cn(
                    'inline-flex h-7 items-center rounded-md px-2 font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-48 w-full">
          {series.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No data for this range yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fleetHashrateFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(ts) => formatTick(ts as number, presetId)}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickMargin={6}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  width={36}
                  tickFormatter={(v) => fmtNum(v, 1)}
                />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(ts) => {
                    const d = new Date(ts as number);
                    return d.toLocaleString();
                  }}
                  formatter={(v: number) => [`${fmtNum(v, 2)} TH/s`, 'Hashrate']}
                />
                <Area
                  type="monotone"
                  dataKey="ths"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#fleetHashrateFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
