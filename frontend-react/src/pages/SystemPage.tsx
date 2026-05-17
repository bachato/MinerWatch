import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Cpu,
  HardDrive,
  MemoryStick,
  Server,
  Thermometer,
  Wind,
  ZapOff,
} from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { fmtNum, fmtUptime, tempTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useSetSystemFan, useSystemInfo, useSystemSnapshot } from '@/api/hooks';
import type { SystemSnapshot } from '@/lib/types';

const TEMP_BUFFER_SIZE = 60; // 5 min @ 5s polling

/**
 * Host metrics page. Shown only on Raspberry Pi (the backend reports
 * is_raspberry=false on other hosts, and we render a placeholder). The
 * temperature chart keeps an in-memory ring buffer of the last 60
 * snapshots so we don't pull a separate history endpoint.
 */
export function SystemPage() {
  const { data: info, isLoading: infoLoading } = useSystemInfo();
  const { data: snap } = useSystemSnapshot();

  // Ring buffer of CPU temps for the chart at the bottom. Survives
  // re-renders via a ref; we re-derive the React state when the
  // snapshot ts changes.
  const bufferRef = useRef<Array<{ ts: number; value: number }>>([]);
  const [bufferTick, setBufferTick] = useState(0);

  useEffect(() => {
    if (!snap || snap.temperature_c === null || snap.temperature_c === undefined) return;
    bufferRef.current.push({ ts: snap.ts * 1000, value: snap.temperature_c });
    if (bufferRef.current.length > TEMP_BUFFER_SIZE) {
      bufferRef.current.shift();
    }
    setBufferTick((t) => t + 1);
  }, [snap?.ts, snap?.temperature_c]);

  const tempSeries = useMemo(() => bufferRef.current.slice(), [bufferTick]);

  if (infoLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!info?.is_raspberry) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Only available on Raspberry Pi</CardTitle>
              <CardDescription>
                The System page reads CPU temperature, throttling state and the host fan via
                Pi-specific interfaces.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">System</h1>
        <p className="text-sm text-muted-foreground">Host metrics · live</p>
      </header>

      <HeaderStrip info={info} snap={snap ?? null} />
      <ThrottleStrip snap={snap ?? null} />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CpuTempCard snap={snap ?? null} />
        <CpuLoadCard snap={snap ?? null} />
        <RamCard snap={snap ?? null} />
        <StorageCard snap={snap ?? null} />
      </div>

      <FanCard info={info} snap={snap ?? null} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">CPU temperature · last 5 minutes</CardTitle>
        </CardHeader>
        <CardContent className="h-48">
          {tempSeries.length < 2 ? (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              Collecting…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={tempSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="sysTempFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fb923c" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#fb923c" stopOpacity={0} />
                  </linearGradient>
                </defs>
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
                  labelFormatter={(ts) => new Date(ts as number).toLocaleTimeString()}
                  formatter={(v: number) => [`${fmtNum(v, 1)} °C`, 'CPU temp']}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#fb923c"
                  strokeWidth={2}
                  fill="url(#sysTempFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- subcomponents ----------

interface HeaderStripProps {
  info: NonNullable<ReturnType<typeof useSystemInfo>['data']>;
  snap: SystemSnapshot | null;
}

function HeaderStrip({ info, snap }: HeaderStripProps) {
  const load = snap?.load_average;
  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-4">
        <Field label="Model" value={info.model ?? '—'} />
        <Field label="Kernel" value={info.kernel ?? '—'} mono />
        <Field label="Uptime" value={fmtUptime(snap?.uptime_seconds ?? null)} />
        <Field
          label="Load (1/5/15)"
          value={
            load && load.length >= 3
              ? `${fmtNum(load[0], 2)} / ${fmtNum(load[1], 2)} / ${fmtNum(load[2], 2)}`
              : '—'
          }
        />
      </CardContent>
    </Card>
  );
}

function ThrottleStrip({ snap }: { snap: SystemSnapshot | null }) {
  const t = snap?.throttled ?? null;
  if (!t) return null;
  const items: Array<{ label: string; flag: boolean | null | undefined; tone: 'now' | 'ever' }> = [
    { label: 'Under-voltage now', flag: t.now_undervoltage, tone: 'now' },
    { label: 'Throttled now', flag: t.now_throttled, tone: 'now' },
    { label: 'Freq capped now', flag: t.now_freq_capped, tone: 'now' },
    { label: 'Soft temp limit now', flag: t.now_soft_temp_limit, tone: 'now' },
    { label: 'Under-voltage ever', flag: t.ever_undervoltage, tone: 'ever' },
    { label: 'Throttled ever', flag: t.ever_throttled, tone: 'ever' },
  ];
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-2 p-3">
        <ZapOff className="mr-1 h-4 w-4 text-muted-foreground" />
        <span className="mr-2 text-xs uppercase tracking-wider text-muted-foreground">Throttling</span>
        {items.map((it) => {
          if (it.flag === null || it.flag === undefined) {
            return <Badge key={it.label} variant="outline">{it.label}: —</Badge>;
          }
          const tone = it.flag ? (it.tone === 'now' ? 'danger' : 'warning') : 'success';
          return (
            <Badge key={it.label} variant={tone}>
              {it.label}: {it.flag ? 'yes' : 'no'}
            </Badge>
          );
        })}
      </CardContent>
    </Card>
  );
}

function CpuTempCard({ snap }: { snap: SystemSnapshot | null }) {
  const t = snap?.temperature_c ?? null;
  const tone = tempTone(t);
  const cls = tone === 'critical' ? 'text-destructive'
    : tone === 'hot' ? 'text-orange-400'
    : tone === 'warm' ? 'text-amber-400'
    : 'text-emerald-400';
  return (
    <KpiCard
      icon={Thermometer}
      iconTone="text-chart-thermal"
      label="CPU temp"
      valueClass={cls}
      value={t !== null ? fmtNum(t, 1) : '—'}
      unit="°C"
    />
  );
}

function CpuLoadCard({ snap }: { snap: SystemSnapshot | null }) {
  const cpu = snap?.cpu;
  return (
    <KpiCard
      icon={Cpu}
      iconTone="text-chart-hardware"
      label="CPU usage"
      value={cpu?.percent !== null && cpu?.percent !== undefined ? fmtNum(cpu.percent, 0) : '—'}
      unit="%"
      footer={cpu?.freq_mhz ? `${fmtNum(cpu.freq_mhz, 0)} MHz` : undefined}
    />
  );
}

function RamCard({ snap }: { snap: SystemSnapshot | null }) {
  const used = snap?.memory?.used_bytes ?? null;
  const total = snap?.memory?.total_bytes ?? null;
  return (
    <KpiCard
      icon={MemoryStick}
      iconTone="text-chart-mining"
      label="RAM"
      value={bytesShort(used)}
      unit={total ? `/ ${bytesShort(total)}` : ''}
      footer={used && total ? `${fmtNum((used / total) * 100, 0)}%` : undefined}
    />
  );
}

function StorageCard({ snap }: { snap: SystemSnapshot | null }) {
  const used = snap?.disk?.used_bytes ?? null;
  const total = snap?.disk?.total_bytes ?? null;
  return (
    <KpiCard
      icon={HardDrive}
      iconTone="text-chart-power"
      label="Storage"
      value={bytesShort(used)}
      unit={total ? `/ ${bytesShort(total)}` : ''}
      footer={used && total ? `${fmtNum((used / total) * 100, 0)}%` : undefined}
    />
  );
}

interface KpiCardProps {
  icon: React.ComponentType<{ className?: string }>;
  iconTone: string;
  label: string;
  value: string;
  unit: string;
  valueClass?: string;
  footer?: string;
}

function KpiCard({ icon: Icon, iconTone, label, value, unit, valueClass, footer }: KpiCardProps) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-md bg-card-foreground/5', iconTone)}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className={cn('text-xl font-semibold tabular-nums', valueClass)}>
            {value}
            {unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>}
          </div>
          {footer && <div className="text-xs text-muted-foreground">{footer}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('text-sm font-semibold', mono && 'font-mono text-xs')}>{value}</div>
    </div>
  );
}

interface FanCardProps {
  info: NonNullable<ReturnType<typeof useSystemInfo>['data']>;
  snap: SystemSnapshot | null;
}

function FanCard({ info, snap }: FanCardProps) {
  const fanInfo = info.fan;
  const fanSnap = snap?.fan ?? null;
  const setFan = useSetSystemFan();
  const initialPct = (() => {
    if (fanSnap?.percent !== null && fanSnap?.percent !== undefined) return Math.round(fanSnap.percent);
    if (fanInfo?.max_state && fanSnap?.state !== null && fanSnap?.state !== undefined) {
      return Math.round((Number(fanSnap.state) / Number(fanInfo.max_state)) * 100);
    }
    return 50;
  })();
  const [pct, setPct] = useState<number>(initialPct);
  const [error, setError] = useState<string | null>(null);
  const [info_, setInfo] = useState<string | null>(null);

  if (!fanInfo) return null;

  async function apply() {
    setError(null);
    setInfo(null);
    try {
      if (fanInfo?.controllable) {
        await setFan.mutateAsync({ percent: pct });
        setInfo(`Fan set to ${pct}%`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-chart-mining/15 text-chart-mining">
            <Wind className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">Host fan</CardTitle>
            <CardDescription>
              {fanInfo.controllable
                ? 'Controlled via the kernel cooling subsystem (max state ' + (fanInfo.max_state ?? '?') + ').'
                : 'Read-only — your platform does not expose a controllable fan.'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Speed" value={fanSnap?.percent !== null && fanSnap?.percent !== undefined ? `${fmtNum(fanSnap.percent, 0)} %` : '—'} />
          {fanInfo.has_rpm && (
            <Field label="RPM" value={fanSnap?.rpm !== null && fanSnap?.rpm !== undefined ? String(fanSnap.rpm) : '—'} />
          )}
          {fanInfo.max_state !== null && fanInfo.max_state !== undefined && (
            <Field
              label="State"
              value={fanSnap?.state !== null && fanSnap?.state !== undefined
                ? `${fanSnap.state} / ${fanInfo.max_state}`
                : '—'}
            />
          )}
        </div>
        {fanInfo.controllable && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">Manual speed</span>
              <span className="text-sm font-semibold tabular-nums">{pct}%</span>
            </div>
            <Slider
              value={[pct]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => setPct(v[0] ?? pct)}
              disabled={setFan.isPending}
            />
            <Button onClick={apply} disabled={setFan.isPending} className="w-full sm:w-auto">
              Apply
            </Button>
          </div>
        )}
        {(info_ || error) && (
          <p className={`text-sm ${error ? 'text-destructive' : 'text-emerald-400'}`} role="status">
            {error ?? info_}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function bytesShort(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`;
}
