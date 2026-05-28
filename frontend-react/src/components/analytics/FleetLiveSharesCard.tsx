import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { Radio } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { fmtDifficulty, fmtNum } from '@/lib/format';
import { colorForMinerId, useLiveSharesFleet } from '@/lib/useLiveSharesFleet';
import type { MinerListEntry } from '@/lib/types';

// AxeOS-derived firmwares are the only ones that expose a per-share log
// WebSocket (see backend/log_streamer.py). cgminer families are skipped.
const AXEOS_FAMILIES = new Set(['bitaxe', 'nerdoctaxe']);

const RANGES: Array<{ label: string; seconds: number }> = [
  { label: '1m', seconds: 60 },
  { label: '3m', seconds: 180 },
  { label: '10m', seconds: 600 },
];

const FILTER_STORAGE_KEY = 'mw-fleet-shares-filter';
const SHOW_BELOW_KEY = 'mw-fleet-shares-show-below';

const HASHES_PER_DIFF = 4294967296;

interface ChartPoint {
  ts: number;
  diff: number;
  target: number;
  submitted: boolean;
  accepted: boolean | null;
  minerId: number;
  minerName: string;
}

interface Props {
  miners: MinerListEntry[];
}

function readDisabledSet(): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is number => typeof v === 'number'));
  } catch {
    return new Set();
  }
}

function writeDisabledSet(s: Set<number>): void {
  try {
    window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify([...s]));
  } catch {
    /* private-mode Safari etc. — drop silently */
  }
}

/**
 * Fleet-wide live shares scatter. One subscription per AxeOS miner,
 * one color per miner, time on X, log-scale difficulty on Y. The
 * legend doubles as a per-miner toggle; off-state is persisted to
 * localStorage so a user's filtering survives reloads.
 *
 * "Show all results" toggles the below-target cloud. When off, the
 * chart shows only submitted shares — cleaner with many miners.
 */
export function FleetLiveSharesCard({ miners }: Props) {
  const axeMiners = useMemo(
    () => miners.filter((m) => AXEOS_FAMILIES.has(m.family) && m.enabled !== 0),
    [miners],
  );

  const [rangeSec, setRangeSec] = useState(180);

  const [disabledIds, setDisabledIds] = useState<Set<number>>(readDisabledSet);
  const [showBelow, setShowBelow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SHOW_BELOW_KEY) === '1';
  });

  // Subscribe only to miners the user has NOT filtered out — this
  // way the browser doesn't burn a connection per hidden device.
  const subscribedIds = useMemo(
    () => axeMiners.filter((m) => !disabledIds.has(m.id)).map((m) => m.id),
    [axeMiners, disabledIds],
  );

  const { eventsByMiner, connectedByMiner } = useLiveSharesFleet(subscribedIds);

  const minerById = useMemo(() => {
    const m = new Map<number, MinerListEntry>();
    for (const x of axeMiners) m.set(x.id, x);
    return m;
  }, [axeMiners]);

  // Group points by miner for one <Scatter> series per miner; that
  // way Recharts colors them independently. Below-target events are
  // optionally included.
  const { seriesByMiner, xMin, xMax, yDomain, hasData } = useMemo(() => {
    const now = Date.now();
    const min = now - rangeSec * 1000;
    const max = now;

    const seriesByMinerLocal: Record<number, ChartPoint[]> = {};
    let lo = Infinity;
    let hi = -Infinity;
    let count = 0;

    for (const id of subscribedIds) {
      const events = eventsByMiner[id] ?? [];
      const miner = minerById.get(id);
      const name = miner?.name ?? `#${id}`;
      const arr: ChartPoint[] = [];
      for (const e of events) {
        if (e.ts < min) continue;
        if (!showBelow && !e.submitted) continue;
        arr.push({
          ts: e.ts,
          diff: e.diff,
          target: e.target,
          submitted: e.submitted,
          accepted: e.accepted,
          minerId: id,
          minerName: name,
        });
        if (e.diff < lo) lo = e.diff;
        if (e.diff > hi) hi = e.diff;
        count += 1;
      }
      if (arr.length) seriesByMinerLocal[id] = arr;
    }

    const has = count > 0;
    const yLo = has ? Math.max(1, lo * 0.6) : 1;
    const yHi = has ? Math.max(hi, 1) * 1.5 : 1000;

    return {
      seriesByMiner: seriesByMinerLocal,
      xMin: min,
      xMax: max,
      yDomain: [yLo, yHi] as [number, number],
      hasData: has,
    };
  }, [eventsByMiner, subscribedIds, rangeSec, showBelow, minerById]);

  // Sliding "now" makes the chart march left even when no shares
  // arrive in a quiet window; otherwise xMax sticks to the last
  // share's ts and the chart looks frozen.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  function toggleMiner(id: number) {
    setDisabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeDisabledSet(next);
      return next;
    });
  }

  function toggleShowBelow() {
    setShowBelow((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SHOW_BELOW_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Per-miner instantaneous estimated hashrate over the last 60s.
  // Useful as a sanity-check next to each legend entry, so the user
  // sees not just colours but also "who is contributing what" while
  // glancing at the chart.
  const estHashrateByMiner = useMemo(() => {
    const out: Record<number, number | null> = {};
    const now = Date.now();
    const cutoff = now - 60_000;
    for (const id of subscribedIds) {
      const events = eventsByMiner[id] ?? [];
      const subs = events.filter((e) => e.submitted && e.ts >= cutoff);
      if (subs.length < 2) {
        out[id] = null;
        continue;
      }
      const spanS = Math.max(1, (subs[subs.length - 1].ts - subs[0].ts) / 1000);
      const sumTarget = subs.reduce((a, e) => a + e.target, 0);
      out[id] = (sumTarget * HASHES_PER_DIFF) / spanS / 1e12;
    }
    return out;
  }, [eventsByMiner, subscribedIds]);

  // ---- empty / unsupported state ----
  if (!axeMiners.length) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-chart-mining/15 text-chart-mining">
            <Radio className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">All miners — live shares</CardTitle>
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

  const anyConnected = axeMiners.some((m) => !disabledIds.has(m.id) && connectedByMiner[m.id]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-chart-mining/15 text-chart-mining">
            <Radio className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              All miners — live shares
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-[11px] font-normal',
                  anyConnected ? 'text-emerald-400' : 'text-amber-400',
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    anyConnected ? 'bg-emerald-400' : 'bg-amber-400',
                  )}
                />
                {anyConnected ? 'Live' : 'Connecting…'}
              </span>
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Every share from every AxeOS miner, on one chart
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={showBelow ? 'default' : 'ghost'}
            className="h-7 px-2.5 text-xs"
            onClick={toggleShowBelow}
            title="Include the ASIC's raw below-target output"
          >
            {showBelow ? 'All results' : 'Submitted only'}
          </Button>
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
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Per-miner toggles. Click to hide a miner from the chart;
            persisted across reloads via localStorage. The color
            swatch matches the dots in the scatter. */}
        <div className="flex flex-wrap gap-1.5">
          {axeMiners.map((m) => {
            const off = disabledIds.has(m.id);
            const color = colorForMinerId(m.id);
            const est = estHashrateByMiner[m.id];
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => toggleMiner(m.id)}
                aria-pressed={!off}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  off
                    ? 'border-border bg-muted/30 text-muted-foreground line-through'
                    : 'border-border bg-card text-foreground hover:bg-accent',
                )}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor: off ? 'transparent' : color,
                    border: off ? '1px solid hsl(var(--border))' : undefined,
                  }}
                />
                <span className="font-medium">{m.name}</span>
                {!off && est != null && (
                  <span className="tabular-nums text-muted-foreground">
                    {fmtNum(est, 2)} TH/s
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Scatter */}
        <div className="h-72 w-full">
          {!hasData ? (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              {subscribedIds.length === 0
                ? 'All miners are filtered out — toggle one back on above.'
                : 'Waiting for the first share…'}
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
                {Object.entries(seriesByMiner).map(([idStr, points]) => {
                  const id = Number(idStr);
                  const color = colorForMinerId(id);
                  return (
                    <Scatter
                      key={id}
                      name={minerById.get(id)?.name ?? `#${id}`}
                      data={points}
                      fill={color}
                      isAnimationActive={false}
                      // Slightly fade the below-target cloud so the
                      // submitted shares (the interesting ones) pop.
                      shape={(props: ShapeProps) => {
                        const cx = props.cx ?? 0;
                        const cy = props.cy ?? 0;
                        const p = props.payload as ChartPoint;
                        const submitted = p.submitted;
                        const rejected = submitted && p.accepted === false;
                        return (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={submitted ? 3.5 : 2.2}
                            fill={color}
                            fillOpacity={submitted ? 0.95 : 0.25}
                            stroke={rejected ? '#ef4444' : 'none'}
                            strokeWidth={rejected ? 1.5 : 0}
                          />
                        );
                      }}
                    />
                  );
                })}
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Each dot is one share, coloured by miner. Solid dots are shares submitted to the pool;
          a red outline marks a rejected submission.
          {showBelow && ' Faint dots are below-target ASIC results.'}
        </p>
      </CardContent>
    </Card>
  );
}

interface ShapeProps {
  cx?: number;
  cy?: number;
  payload?: ChartPoint;
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
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: colorForMinerId(p.minerId) }}
        />
        <span className="font-semibold">{p.minerName}</span>
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{fmtDifficulty(p.diff)}</div>
      <div className="text-muted-foreground">target {fmtDifficulty(p.target)}</div>
      <div className="text-muted-foreground">{verdict}</div>
      <div className="text-muted-foreground">{new Date(p.ts).toLocaleTimeString()}</div>
    </div>
  );
}
