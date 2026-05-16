import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtDifficulty, fmtNum, fmtUptime, tempTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { LiveSample, MetricSample, MinerDetailResponse } from '@/lib/types';

interface Props {
  data: MinerDetailResponse;
}

/**
 * Overview tab: a single panel with all current metrics for the
 * selected miner. Prefers the live sample (in-memory, fresher) and
 * falls back to the latest DB row when polling hasn't arrived yet —
 * same logic as the vanilla `renderLiveStats`.
 */
export function LiveStats({ data }: Props) {
  const lm = data.last_metric;
  const ls = data.live_sample;
  const status = data.miner.last_status ?? (data.live_sample?.online ? 'online' : 'unknown');
  const error = ls?.error ?? null;

  const v = <K extends keyof MetricSample & keyof LiveSample>(key: K): number | string | null | undefined => {
    if (ls && (ls as Record<K, unknown>)[key] !== null && (ls as Record<K, unknown>)[key] !== undefined) {
      return (ls as Record<K, unknown>)[key] as number | string | null | undefined;
    }
    return (lm as Record<K, unknown> | null | undefined)?.[key] as number | string | null | undefined;
  };

  const family = data.miner.family;
  const vrLabel = family === 'canaan' ? 'Air outlet temp' : 'Temp VR';

  const hashrate = v('hashrate_ths') as number | null;
  const power = v('power_w') as number | null;
  const tempChip = v('temp_chip_c') as number | null;
  const tempVr = v('temp_vr_c') as number | null;
  const tempIn = ls?.temp_inlet_c ?? null;
  const tempOut = ls?.temp_outlet_c ?? null;
  const tempAvg = ls?.temp_avg_c ?? null;
  const eff = power && hashrate ? power / hashrate : null;
  const uptime = v('uptime_s') as number | null;
  const accepted = v('accepted') as number | null;
  const rejected = v('rejected') as number | null;
  const fanRpm = v('fan_rpm') as number | null;
  const fanPct = v('fan_pct') as number | null;
  const freq = v('frequency_mhz') as number | null;
  const volt = v('voltage_mv') as number | null;
  const bestSession = v('best_difficulty') as number | null;

  type Row = { label: string; value: React.ReactNode };
  const rows: Row[] = [
    { label: 'Status', value: <StatusCell status={status} error={error ?? undefined} /> },
    { label: 'Hashrate', value: <NumberCell value={fmtNum(hashrate, 2)} unit="TH/s" /> },
    { label: 'Power', value: <NumberCell value={fmtNum(power, 1)} unit="W" /> },
    { label: 'Efficiency', value: <NumberCell value={eff ? fmtNum(eff, 1) : '—'} unit="W/TH" /> },
    {
      label: 'Max chip temp',
      value: <NumberCell value={fmtNum(tempChip, 1)} unit="°C" tone={tempTone(tempChip)} />,
    },
  ];
  if (tempAvg !== null && tempAvg !== undefined) {
    rows.push({
      label: 'Average chip temp',
      value: <NumberCell value={fmtNum(tempAvg, 1)} unit="°C" tone={tempTone(tempAvg)} />,
    });
  }
  rows.push({
    label: vrLabel,
    value: <NumberCell value={fmtNum(tempVr, 1)} unit="°C" tone={tempTone(tempVr)} />,
  });
  if (tempIn !== null && tempIn !== undefined) {
    rows.push({
      label: 'Air inlet temp',
      value: <NumberCell value={fmtNum(tempIn, 1)} unit="°C" />,
    });
  }
  if (family !== 'canaan' && tempOut !== null && tempOut !== undefined) {
    rows.push({
      label: 'Air outlet temp',
      value: <NumberCell value={fmtNum(tempOut, 1)} unit="°C" />,
    });
  }
  rows.push(
    {
      label: 'Fan',
      value: (
        <NumberCell
          value={fanRpm !== null && fanRpm !== undefined ? String(fanRpm) : '—'}
          unit={`rpm${fanPct !== null && fanPct !== undefined ? ` · ${fmtNum(fanPct, 0)}%` : ''}`}
        />
      ),
    },
    { label: 'Frequency', value: <NumberCell value={freq ? `${fmtNum(freq, 0)}` : '—'} unit="MHz" /> },
    { label: 'Voltage', value: <NumberCell value={volt ? String(volt) : '—'} unit="mV" /> },
    { label: 'ASIC count', value: <NumberCell value={ls?.asic_count ? String(ls.asic_count) : '—'} unit="" /> },
    { label: 'Uptime', value: <NumberCell value={fmtUptime(uptime)} unit="" /> },
    {
      label: 'Accepted / Rejected',
      value: (
        <NumberCell
          value={`${accepted ?? '—'} / ${rejected ?? '—'}`}
          unit=""
        />
      ),
    },
    {
      label: 'Best difficulty (session)',
      value: <NumberCell value={bestSession ? fmtDifficulty(bestSession) : '—'} unit="" />,
    },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Current status</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 md:grid-cols-4">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {r.label}
              </span>
              <span className="text-sm font-semibold tabular-nums">{r.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusCell({ status, error }: { status: string; error?: string }) {
  const colour =
    status === 'online' ? 'text-emerald-400'
    : status === 'offline' ? 'text-destructive'
    : 'text-muted-foreground';
  return (
    <span className={colour}>
      <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" />
      {status}
      {error && <span className="ml-2 text-xs font-normal text-muted-foreground">· {error}</span>}
    </span>
  );
}

interface NumberCellProps {
  value: string;
  unit: string;
  tone?: ReturnType<typeof tempTone>;
}

function NumberCell({ value, unit, tone }: NumberCellProps) {
  const toneCls =
    tone === 'critical' ? 'text-destructive'
    : tone === 'hot' ? 'text-orange-400'
    : tone === 'warm' ? 'text-amber-400'
    : 'text-foreground';
  return (
    <span className={cn('inline-flex items-baseline gap-1', toneCls)}>
      {value}
      {unit && <span className="text-[10px] font-normal text-muted-foreground">{unit}</span>}
    </span>
  );
}
