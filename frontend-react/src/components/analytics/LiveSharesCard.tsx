import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { Radio, Trophy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtDifficulty, fmtNum, fmtRelative } from '@/lib/format';
import { useLiveShares } from '@/lib/useLiveShares';
import { useMinerNotableShares } from '@/api/hooks';
import type { MinerListEntry } from '@/lib/types';

// AxeOS-derived firmwares are the only ones that expose a per-share log
// WebSocket (see backend/log_streamer.py). cgminer families are skipped.
const AXEOS_FAMILIES = new Set(['bitaxe', 'nerdoctaxe']);

const RANGES: Array<{ label: string; seconds: number }> = [
  { label: '1m', seconds: 60 },
  { label: '3m', seconds: 180 },
  { label: '10m', seconds: 600 },
];

// Difficulty 1 ≈ 2^32 hashes (Bitcoin). Used for the share-based
// instantaneous hashrate estimate.
const HASHES_PER_DIFF = 4294967296;

interface ChartPoint {
  ts: number;
  diff: number;
  target: number;
  submitted: boolean;
  accepted: boolean | null;
}

interface Props {
  miners: MinerListEntry[];
}

/**
 * Live per-share scatter for AxeOS miners. Every ASIC result is plotted
 * the instant it lands: a dense cloud of below-target results, the
 * dashed pool-target line, and the submitted shares above it. Fed by the
 * SSE stream; falls back to a clear "AxeOS only" state otherwise.
 */
export function LiveSharesCard({ miners }: Props) {
  const axeMiners = useMemo(
    () => miners.filter((m) => AXEOS_FAMILIES.has(m.family) && m.enabled !== 0),
    [miners],
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [rangeSec, setRangeSec] = useState(180);

  const activeId =
    selectedId != null && axeMiners.some((m) => m.id === selectedId)
      ? selectedId
      : axeMiners[0]?.id ?? null;
  const activeMiner = axeMiners.find((m) => m.id === activeId) ?? null;

  const { events, stats, connected } = useLiveShares(activeId ?? undefined);
  const { data: notable } = useMinerNotableShares(activeId ?? undefined, 15);

  const { below, accepted, rejected, xMin, xMax, yDomain, target, hasData } = useMemo(() => {
    const latest = events.length ? events[events.length - 1].ts : Date.now();
    const max = latest;
    const min = max - rangeSec * 1000;
    const inWindow = events.filter((e) => e.ts >= min);

    const toPoint = (e: (typeof events)[number]): ChartPoint => ({
      ts: e.ts,
      diff: e.diff,
      target: e.target,
      submitted: e.submitted,
      accepted: e.accepted,
    });

    const diffs = inWindow.map((e) => e.diff);
    const tgt = stats?.current_target ?? (inWindow.length ? inWindow[inWindow.length - 1].target : null);
    const has = diffs.length > 0;
    const lo = has ? Math.max(1, Math.min(...diffs) * 0.6) : 1;
    const hi = has ? Math.max(...diffs, tgt ?? 1) * 1.5 : 1000;

    return {
      below: inWindow.filter((e) => !e.submitted).map(toPoint),
      accepted: inWindow.filter((e) => e.submitted && e.accepted !== false).map(toPoint),
      rejected: inWindow.filter((e) => e.submitted && e.accepted === false).map(toPoint),
      xMin: min,
      xMax: max,
      yDomain: [lo, hi] as [number, number],
      target: tgt,
      hasData: has,
    };
  }, [events, rangeSec, stats]);

  // Share-based instantaneous hashrate: each submitted share ≈ target ×
  // 2^32 hashes of work. Averaged over the elapsed window (capped 60s).
  const estHashrate = useMemo(() => {
    if (!events.length) return null;
    const latest = events[events.length - 1].ts;
    const cutoff = latest - 60_000;
    const subs = events.filter((e) => e.submitted && e.ts >= cutoff);
    if (subs.length < 2) return null;
    const spanS = Math.max(1, (latest - subs[0].ts) / 1000);
    const sumTarget = subs.reduce((a, e) => a + e.target, 0);
    return (sumTarget * HASHES_PER_DIFF) / spanS / 1e12;
  }, [events]);

  const resultsPerSec = useMemo(() => {
    if (!events.length) return null;
    const latest = events[events.length - 1].ts;
    const cutoff = latest - 10_000;
    const n = events.filter((e) => e.ts >= cutoff).length;
    return n / 10;
  }, [events]);

  // ---- empty / unsupported state ----
  if (!axeMiners.length) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-chart-mining/15 text-chart-mining">
            <Radio className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">Live shares</CardTitle>
            <p className="text-xs text-muted-foreground">Real-time per-share stream</p>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Live per-share streaming reads the firmware log over WebSocket, which only AxeOS
            devices (Bitaxe, NerdQAxe, Titan) expose. No AxeOS miner is currently enabled, so
            there's nothing to stream here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-chart-mining/15 text-chart-mining">
            <Radio className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {activeMiner?.name ?? 'Live shares'}
              <span
                className={
                  'inline-flex items-center gap-1 text-[11px] font-normal ' +
                  (connected ? 'text-emerald-400' : 'text-amber-400')
                }
              >
                <span
                  className={
                    'h-1.5 w-1.5 rounded-full ' + (connected ? 'bg-emerald-400' : 'bg-amber-400')
                  }
                />
                {connected ? 'Live' : 'Connecting…'}
              </span>
            </CardTitle>
            <p className="text-xs text-muted-foreground">Per-share stream from the miner log</p>
          </div>
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
          {RANGES.map((r) => (
            <Button
              key={r.label}
              size="sm"
              variant={rangeSec === r.seconds ? 'default' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setRangeSec(r.seconds)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Miner selector — only shown when more than one AxeOS device */}
        {axeMiners.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {axeMiners.map((m) => (
              <Button
                key={m.id}
                size="sm"
                variant={m.id === activeId ? 'default' : 'ghost'}
                className="h-7 px-2.5 text-xs"
                onClick={() => setSelectedId(m.id)}
              >
                {m.name}
              </Button>
            ))}
          </div>
        )}

        {/* Stats strip */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Est. hashrate" value={estHashrate != null ? `${fmtNum(estHashrate, 2)} TH/s` : '—'} />
          <Stat label="Shares / sec" value={resultsPerSec != null ? fmtNum(resultsPerSec, 1) : '—'} />
          <Stat label="Pool target" value={target != null ? fmtDifficulty(target) : '—'} />
          <Stat
            label="Submitted"
            value={stats ? `${stats.submitted_total}` : '—'}
            sub={stats && stats.rejected_total > 0 ? `${stats.rejected_total} rejected` : 'this session'}
          />
        </div>

        {/* Scatter */}
        <div className="h-64 w-full">
          {!hasData ? (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              {connected ? 'Waiting for the first share…' : 'Connecting to the miner log…'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="ts"
                  domain={[xMin, xMax]}
                  tickFormatter={fmtClock}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickMargin={6}
                  allowDataOverflow
                />
                <YAxis
                  type="number"
                  dataKey="diff"
                  scale="log"
                  domain={yDomain}
                  tickFormatter={(v) => fmtDifficulty(v, 0)}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  width={52}
                  allowDataOverflow
                />
                <ZAxis range={[18, 18]} />
                <Tooltip content={<ShareTooltip />} />
                {target != null && (
                  <ReferenceLine
                    y={target}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="5 4"
                  />
                )}
                <Scatter data={below} fill="hsl(var(--muted-foreground))" fillOpacity={0.35} isAnimationActive={false} />
                <Scatter data={accepted} fill="hsl(var(--primary))" isAnimationActive={false} />
                <Scatter data={rejected} fill="#ef4444" isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Dots above the dashed pool-target line are shares submitted to the pool; the faint cloud
          below is the ASIC's raw output.
        </p>

        {/* Near-block Hall of Fame */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Trophy className="h-3.5 w-3.5 text-yellow-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Near-block Hall of Fame
            </span>
          </div>
          {notable?.entries?.length ? (
            <div className="flex flex-col gap-1">
              {notable.entries.map((s, idx) => (
                <div
                  key={s.id}
                  className="grid grid-cols-[32px_1fr_auto] items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-1.5 text-sm"
                >
                  <span className="text-xs font-bold text-muted-foreground">#{idx + 1}</span>
                  <span className="font-bold tabular-nums text-primary">{fmtDifficulty(s.share_difficulty)}</span>
                  <span className="text-right text-xs tabular-nums text-muted-foreground">
                    {fmtRelative(s.ts)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No notable shares recorded yet (≥ 1M difficulty). High shares land here automatically
              as the miner finds them — and persist across restarts.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
}

function ShareTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const verdict = !p.submitted
    ? 'below target'
    : p.accepted === false
      ? 'rejected'
      : p.accepted === true
        ? 'accepted'
        : 'submitted';
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md">
      <div className="text-sm font-semibold tabular-nums">{fmtDifficulty(p.diff)}</div>
      <div className="text-muted-foreground">target {fmtDifficulty(p.target)}</div>
      <div className="text-muted-foreground">{verdict}</div>
      <div className="text-muted-foreground">{new Date(p.ts).toLocaleTimeString()}</div>
    </div>
  );
}
