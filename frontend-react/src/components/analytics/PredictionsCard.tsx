import { Target, Award } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtDifficulty, fmtEta, fmtNum, fmtProb } from '@/lib/format';
import type { PredictionResponse, PredictionWindow } from '@/lib/types';

interface Props {
  data: PredictionResponse | null;
}

/**
 * Predictions widget: probabilities computed server-side at
 * /api/fleet/prediction using the Poisson model
 * P(t) = 1 - exp(-rate · t) where rate = H / (D · 2^32).
 *
 * Renders nothing until both fleet hashrate and an all-time best are
 * available (the backend already returns null in that case, but we
 * also gate at the card level to avoid showing an empty header).
 */
export function PredictionsCard({ data }: Props) {
  if (!data) return null;
  const hasFleetHash = data.fleet_hashrate_ths && data.fleet_hashrate_ths > 0;
  const hasBest = !!(data.best_alltime && data.best_alltime.value);
  if (!hasFleetHash || !hasBest) return null;

  const beatBest = data.predictions.beat_best;
  const findBlock = data.predictions.find_block;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Predictions</CardTitle>
          <p className="text-xs text-muted-foreground">
            Statistical odds based on current fleet hashrate
          </p>
        </div>
        <div className="text-right text-xs tabular-nums text-muted-foreground leading-relaxed">
          <div>{fmtNum(data.fleet_hashrate_ths, 2)} TH/s fleet</div>
          <div>best {fmtDifficulty(data.best_alltime!.value)}</div>
          {data.network_difficulty && <div>net {fmtDifficulty(data.network_difficulty)}</div>}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <PredictionBlock
            icon={Award}
            iconTone="text-chart-performance"
            title="Beat all-time best"
            subtitle={`Current record: ${fmtDifficulty(data.best_alltime!.value)}`}
            window={beatBest}
          />
          {data.network_difficulty && (
            <PredictionBlock
              icon={Target}
              iconTone="text-chart-mining"
              title="Find a block (solo)"
              subtitle={`Network difficulty: ${fmtDifficulty(data.network_difficulty)}`}
              window={findBlock}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface BlockProps {
  icon: React.ComponentType<{ className?: string }>;
  iconTone: string;
  title: string;
  subtitle: string;
  window: PredictionWindow | null;
}

function PredictionBlock({ icon: Icon, iconTone, title, subtitle, window: w }: BlockProps) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4">
      <header className="flex items-center gap-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-md bg-card-foreground/5 ${iconTone}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold uppercase tracking-wider">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </header>

      {!w ? (
        <p className="text-xs text-muted-foreground">
          Not enough data yet — waiting for live hashrate and a known target.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between rounded-md border border-border bg-card px-3 py-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Expected time
            </span>
            <span className="text-lg font-bold tabular-nums text-primary">
              {fmtEta(w.expected_time_s)}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <ProbBar label="Within 1 hour" p={w.probability['1h']} />
            <ProbBar label="Within 24 hours" p={w.probability['24h']} />
            <ProbBar label="Within 7 days" p={w.probability['7d']} />
          </div>
        </>
      )}
    </div>
  );
}

function ProbBar({ label, p }: { label: string; p: number | null | undefined }) {
  const pct = (p === null || p === undefined || !Number.isFinite(p))
    ? 0
    : Math.max(0, Math.min(1, p)) * 100;
  return (
    <div className="grid grid-cols-[110px_1fr_60px] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="relative block h-2 rounded-full border border-border bg-card overflow-hidden">
        <span
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary/80 to-primary transition-all"
          style={{ width: `${pct.toFixed(2)}%` }}
        />
      </span>
      <span className="text-right tabular-nums">{fmtProb(p)}</span>
    </div>
  );
}
