import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtNum } from '@/lib/format';
import { useFleetHashrate } from '@/api/hooks';

/**
 * Last-hour fleet hashrate chart, 1-minute buckets. Replaces the
 * hand-drawn SVG of the vanilla dashboard with Recharts — same data,
 * less code, free tooltip + responsiveness.
 */
export function FleetHashrateChart() {
  const { data, isLoading } = useFleetHashrate(60, 60);

  const series = useMemo(() => {
    const points = data?.points ?? [];
    return points.map((p) => ({
      ts: p.ts * 1000,
      ths: p.hashrate_ths,
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

  if (!series.length) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Fleet total hashrate</CardTitle>
          <p className="text-xs text-muted-foreground">1-minute average · last hour</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums text-primary">
            {fmtNum(currentTHs, 2)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">TH/s</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-48 w-full">
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
                tickFormatter={(ts) => {
                  const d = new Date(ts);
                  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                }}
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
        </div>
      </CardContent>
    </Card>
  );
}
