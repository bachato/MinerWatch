import { Activity, Cpu, Flame, Gauge, Zap } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { fmtNum, tempTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { MinerListEntry } from '@/lib/types';

interface Props {
  miners: MinerListEntry[];
}

/**
 * Five top-of-page KPIs. Numbers come straight from the same /api/miners
 * payload the rest of the page consumes — no extra API call needed.
 */
export function FleetSummary({ miners }: Props) {
  const online = miners.filter((m) => m.live_online).length;
  let totalHash = 0;
  let totalPower = 0;
  let maxTemp: number | null = null;

  for (const m of miners) {
    const lm = m.last_metric;
    if (!lm) continue;
    if (m.live_online && lm.hashrate_ths !== null) totalHash += Number(lm.hashrate_ths) || 0;
    if (m.live_online && lm.power_w !== null) totalPower += Number(lm.power_w) || 0;
    if (lm.temp_chip_c !== null) {
      const t = Number(lm.temp_chip_c);
      if (maxTemp === null || t > maxTemp) maxTemp = t;
    }
  }
  const efficiency = totalHash > 0 ? totalPower / totalHash : null;

  const tempToneClass = (() => {
    const t = tempTone(maxTemp);
    return t === 'critical' ? 'text-destructive'
      : t === 'hot' ? 'text-orange-400'
      : t === 'warm' ? 'text-amber-400'
      : 'text-foreground';
  })();

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <Kpi
        icon={Activity}
        iconTone="text-chart-performance"
        label="Miners online"
        value={String(online)}
        unit={`/ ${miners.length}`}
      />
      <Kpi
        icon={Gauge}
        iconTone="text-chart-mining"
        label="Total hashrate"
        value={fmtNum(totalHash, 2)}
        unit="TH/s"
      />
      <Kpi
        icon={Zap}
        iconTone="text-chart-power"
        label="Total power"
        value={fmtNum(totalPower, 0)}
        unit="W"
      />
      <Kpi
        icon={Cpu}
        iconTone="text-chart-hardware"
        label="Efficiency"
        value={efficiency ? fmtNum(efficiency, 1) : '—'}
        unit="W/TH"
      />
      <Kpi
        icon={Flame}
        iconTone="text-chart-thermal"
        label="Max chip temp"
        value={maxTemp !== null ? fmtNum(maxTemp, 1) : '—'}
        unit="°C"
        valueTone={tempToneClass}
      />
    </div>
  );
}

interface KpiProps {
  icon: React.ComponentType<{ className?: string }>;
  iconTone: string;
  label: string;
  value: string;
  unit: string;
  valueTone?: string;
}

function Kpi({ icon: Icon, iconTone, label, value, unit, valueTone }: KpiProps) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className={cn('flex h-9 w-9 items-center justify-center rounded-md bg-card-foreground/5', iconTone)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex flex-col leading-tight">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cn('text-xl font-semibold tabular-nums', valueTone)}>
          {value}
          <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>
        </div>
      </div>
    </Card>
  );
}
