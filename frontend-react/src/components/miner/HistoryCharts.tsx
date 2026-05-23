import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtNum } from '@/lib/format';
import { useMinerMetrics } from '@/api/hooks';

interface Props {
  minerId: number;
}

const RANGES: Array<{ label: string; seconds: number }> = [
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 21600 },
  { label: '24h', seconds: 86400 },
  { label: '7d', seconds: 604800 },
  { label: '30d', seconds: 2592000 },
];

/**
 * History tab: hashrate and temperature time-series over a selectable
 * range. Powered by Recharts so axes, tooltip, and responsiveness come
 * for free. Range selector mirrors the vanilla one.
 */
export function HistoryCharts({ minerId }: Props) {
  const [range, setRange] = useState(86400);
  const now = Math.floor(Date.now() / 1000);
  const fromTs = now - range;
  const toTs = now;

  const { data, isLoading } = useMinerMetrics(minerId, fromTs, toTs);

  const series = useMemo(() => {
    const rows = data?.metrics ?? [];
    // Reject rate is derived on the fly from the cumulative accepted /
    // rejected counters that are already stored in the metrics tables —
    // no extra backend column needed. We compute it *delta-based* between
    // consecutive points (Δrejected / (Δaccepted + Δrejected)) so the line
    // reflects what happened in each window rather than a flat lifetime
    // average. On NerdOctaxe this is also the "HW error %": duplicate HW
    // nonces are submitted to the pool and counted as rejected, so they're
    // included here. Negative deltas (counter reset on a miner restart)
    // and empty windows (no shares) produce a null → a gap in the line.
    type Point = {
      ts: number;
      hashrate: number | null;
      tempChip: number | null;
      tempVr: number | null;
      rejectPct: number | null;
    };
    const out: Point[] = [];
    let prevAcc: number | null = null;
    let prevRej: number | null = null;
    for (const p of rows) {
      const acc = p.accepted;
      const rej = p.rejected;
      let rejectPct: number | null = null;
      if (acc !== null && rej !== null && prevAcc !== null && prevRej !== null) {
        const dAcc = acc - prevAcc;
        const dRej = rej - prevRej;
        if (dAcc >= 0 && dRej >= 0 && dAcc + dRej > 0) {
          rejectPct = (dRej / (dAcc + dRej)) * 100;
        }
      }
      if (acc !== null) prevAcc = acc;
      if (rej !== null) prevRej = rej;
      out.push({
        ts: p.ts * 1000,
        hashrate: p.hashrate_ths,
        tempChip: p.temp_chip_c,
        tempVr: p.temp_vr_c,
        rejectPct,
      });
    }
    return out;
  }, [data]);

  const hasReject = useMemo(
    () => series.some((p) => p.rejectPct !== null),
    [series],
  );

  const tickFormat = (ts: number) => {
    const d = new Date(ts);
    if (range <= 3600) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    if (range <= 86400) {
      return `${String(d.getHours()).padStart(2, '0')}:00`;
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">History</CardTitle>
        <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
          {RANGES.map((r) => (
            <Button
              key={r.label}
              size="sm"
              variant={range === r.seconds ? 'default' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setRange(r.seconds)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ChartBlock title="Hashrate" unit="TH/s" isLoading={isLoading} hasData={!!series.length}>
          <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={tickFormat}
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
              labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
              formatter={(v: number) => [`${fmtNum(v, 2)} TH/s`, 'Hashrate']}
            />
            <Line
              type="monotone"
              dataKey="hashrate"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartBlock>

        <ChartBlock title="Temperature" unit="°C" isLoading={isLoading} hasData={!!series.length}>
          <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={tickFormat}
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              tickMargin={6}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              width={36}
              tickFormatter={(v) => fmtNum(v, 0)}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
              formatter={(v: number, name: string) => [`${fmtNum(v, 1)} °C`, name === 'tempChip' ? 'Chip' : 'VR']}
            />
            <Line type="monotone" dataKey="tempChip" stroke="#fb923c" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="tempVr" stroke="#facc15" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartBlock>

        {/* Reject rate (a.k.a. HW error % on NerdOctaxe). Derived from the
            stored accepted/rejected counters, so full history is available
            retroactively. `hasData` also requires at least one computable
            point so we don't show an empty axis for a range with no shares. */}
        <ChartBlock
          title="Reject rate"
          unit="%"
          isLoading={isLoading}
          hasData={!!series.length && hasReject}
        >
          <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={tickFormat}
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              tickMargin={6}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              width={36}
              domain={[0, 'auto']}
              tickFormatter={(v) => fmtNum(v, 2)}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
              formatter={(v: number) => [`${fmtNum(v, 3)} %`, 'Reject rate']}
            />
            <Line
              type="monotone"
              dataKey="rejectPct"
              stroke="#f87171"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          </LineChart>
        </ChartBlock>
      </CardContent>
    </Card>
  );
}

interface ChartBlockProps {
  title: string;
  unit: string;
  isLoading: boolean;
  hasData: boolean;
  children: React.ReactElement;
}

function ChartBlock({ title, unit, isLoading, hasData, children }: ChartBlockProps) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <span className="text-[11px] text-muted-foreground">{unit}</span>
      </div>
      <div className="h-56 w-full">
        {isLoading && !hasData ? (
          <Skeleton className="h-full w-full" />
        ) : !hasData ? (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
            No data in this range
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
