/**
 * Per-hashboard cards inspired by the LuxOS dashboard layout.
 *
 * One card per physical board, showing:
 *  - voltage (V), frequency (MHz), per-board hashrate (5min + nominal)
 *  - chip health summary (Healthy / Unhealthy / Unknown counts) — the
 *    feature LuxOS users specifically asked for, fed by `healthchipget`.
 *  - per-sensor temperatures, grouped by the firmware-provided label
 *    (e.g. "Board Exhaust" / "Board Intake") with the two readings
 *    per group (top + bottom) shown side-by-side.
 *
 * The component renders nothing when `boards` is empty so it stays
 * invisible on single-board miners (Bitaxe etc.). For Braiins/Canaan
 * we currently don't populate `boards` either, so it stays hidden
 * there too — keeping the Hardware tab dense for those families.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtNum, tempTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BoardSnapshot, MinerDetailResponse } from '@/lib/types';

interface Props {
  data: MinerDetailResponse;
}

export function Hashboards({ data }: Props) {
  const boards = data.live_sample?.boards ?? [];
  if (boards.length === 0) return null;

  // Roll up totals to mirror LuxOS's header (e.g. "315 MHz · 65 TH/s ·
  // 231 chips"). We compute these client-side rather than reading
  // them from the sample so the header stays in sync with whatever
  // subset of fields actually came back from the firmware.
  const avgFreq = avg(boards.map((b) => b.frequency_mhz));
  const totalHash = sum(boards.map((b) => b.hashrate_ths));
  const totalChips = sum(boards.map((b) => b.chips_total));
  const unhealthy = sum(boards.map((b) => b.chips_unhealthy));
  const unknown = sum(boards.map((b) => b.chips_unknown));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-3">
        <CardTitle className="text-base">Hashboards</CardTitle>
        <div className="flex flex-wrap items-baseline gap-x-3 text-xs tabular-nums text-muted-foreground">
          {avgFreq !== null && (
            <span>
              <span className="font-semibold text-amber-400">{fmtNum(avgFreq, 0)}</span> MHz
            </span>
          )}
          {totalHash !== null && (
            <span>
              <span className="font-semibold text-foreground">{fmtNum(totalHash, 2)}</span> TH/s
            </span>
          )}
          {totalChips !== null && (
            <span>
              <span className="font-semibold text-foreground">{totalChips}</span> chips
              {(unhealthy ?? 0) > 0 && (
                <span className="ml-1 text-destructive">· {unhealthy} unhealthy</span>
              )}
              {(unknown ?? 0) > 0 && (
                <span className="ml-1 text-amber-400">· {unknown} unknown</span>
              )}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {boards.map((b) => (
            <BoardCard key={b.id} board={b} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BoardCard({ board }: { board: BoardSnapshot }) {
  const tone =
    board.status && board.status.toLowerCase() !== 'alive'
      ? 'text-destructive'
      : board.enabled === false
        ? 'text-amber-400'
        : 'text-emerald-400';

  return (
    <div className="rounded-md border border-border/60 bg-card/50 p-3">
      {/* Header — board ID + connector + status dot */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 rounded-full bg-current', tone)} />
          <span className="text-sm font-semibold">Hashboard #{board.id}</span>
          {board.connector && (
            <span className="text-xs text-muted-foreground">({board.connector})</span>
          )}
        </div>
        {board.enabled === false && (
          <Badge variant="warning">Disabled</Badge>
        )}
      </div>

      {/* Voltage + Frequency row */}
      <div className="grid grid-cols-2 gap-3 border-b border-border/40 pb-2">
        <Stat
          label="Current voltage"
          value={board.voltage_v !== null ? fmtNum(board.voltage_v, 2) : '—'}
          unit="V"
        />
        <Stat
          label="Current frequency"
          value={board.frequency_mhz !== null ? fmtNum(board.frequency_mhz, 0) : '—'}
          unit="MHz"
        />
      </div>

      {/* Hashrate row — actual vs nominal, side by side */}
      <div className="grid grid-cols-2 gap-3 border-b border-border/40 py-2">
        <Stat
          label="Hashrate"
          value={board.hashrate_ths !== null ? fmtNum(board.hashrate_ths, 2) : '—'}
          unit="TH/s"
          // Subtle indicator: arrow up when within 2% of nominal, down
          // otherwise. Helps the user spot an underperforming board at
          // a glance, mirroring LuxOS's own arrows in the dashboard.
          trend={trendFor(board.hashrate_ths, board.nominal_ths)}
        />
        <Stat
          label="Nominal hashrate"
          value={board.nominal_ths !== null ? fmtNum(board.nominal_ths, 2) : '—'}
          unit="TH/s"
        />
      </div>

      {/* Chip health — the LuxOS feature the community asked for */}
      {board.chips_total !== null && (
        <div className="border-b border-border/40 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Chips health
          </div>
          <div className="flex items-baseline gap-4">
            <HealthCount count={board.chips_healthy} tone="ok" label="Healthy" />
            <HealthCount count={board.chips_unknown} tone="warn" label="Unknown" />
            <HealthCount count={board.chips_unhealthy} tone="bad" label="Unhealthy" />
          </div>
        </div>
      )}

      {/* Temperatures — grouped by firmware label so "Board Exhaust" or
          "Board Intake" stays a single row with its two sensors. */}
      <TempsBlock board={board} />
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
  unit: string;
  trend?: 'up' | 'down' | null;
}

function Stat({ label, value, unit, trend }: StatProps) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="inline-flex items-baseline gap-1 text-sm font-semibold tabular-nums">
        {value}
        <span className="text-[10px] font-normal text-muted-foreground">{unit}</span>
        {trend === 'up' && <span className="text-emerald-400">▲</span>}
        {trend === 'down' && <span className="text-destructive">▼</span>}
      </span>
    </div>
  );
}

function HealthCount({
  count,
  tone,
  label,
}: {
  count: number | null;
  tone: 'ok' | 'warn' | 'bad';
  label: string;
}) {
  const cls =
    tone === 'ok' ? 'text-emerald-400'
    : tone === 'warn' ? 'text-muted-foreground'
    : 'text-destructive';
  // Display 0 explicitly when known — for "Unhealthy" / "Unknown" a
  // "0" is a meaningful "all good" signal, while `null` means the
  // firmware didn't report it (older builds).
  const display = count !== null ? String(count) : '—';
  return (
    <div className="flex flex-col">
      <span className={cn('text-base font-semibold tabular-nums', cls)}>{display}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function TempsBlock({ board }: { board: BoardSnapshot }) {
  const entries = Object.entries(board.temps_extra ?? {});
  if (entries.length === 0) {
    // Fallback for builds that don't expose per-sensor data: show the
    // max chip temp on its own so the card still reads as informative.
    if (board.temp_chip_c === null) return null;
    return (
      <div className="pt-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Max chip temp
        </div>
        <span
          className={cn(
            'inline-flex items-baseline gap-1 text-sm font-semibold tabular-nums',
            toneClass(tempTone(board.temp_chip_c)),
          )}
        >
          {fmtNum(board.temp_chip_c, 1)}
          <span className="text-[10px] font-normal text-muted-foreground">°C</span>
        </span>
      </div>
    );
  }

  // One cell per physical sensor. LuxOS METADATA labels ALREADY encode
  // the position (e.g. "Board Exhaust (top)"), so the old code — which
  // grouped by label and then appended another "(top)/(bottom)" —
  // produced duplicated rows like "Board Exhaust (top) (top)" with half
  // the cells empty ("—"). We instead normalise each sensor to a compact
  // "<vertical> <side>" label (Intake/Inlet = Front, Exhaust/Outlet =
  // Back) and render the four sensors directly.
  const cells = entries.map(([pos, value]) => ({
    pos,
    label: prettyTempLabel(pos, board.temps_labels[pos]),
    value,
  }));
  // Stable, human reading order; unknown labels fall to the end.
  const ORDER = ['Top Front', 'Bottom Front', 'Top Back', 'Bottom Back'];
  cells.sort((a, b) => {
    const ia = ORDER.indexOf(a.label);
    const ib = ORDER.indexOf(b.label);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return (
    <div className="pt-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        Temperature
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {cells.map((c) => (
          <TempCell key={c.pos} label={c.label} value={c.value} />
        ))}
      </div>
    </div>
  );
}

/**
 * Normalise a LuxOS temperature sensor to a compact "<vertical> <side>"
 * label, e.g. "Top Front". The firmware METADATA label (when present)
 * already names the sensor ("Board Exhaust (top)", "Board Intake
 * (bottom)", "Water Inlet", …) and the raw position key (TopLeft,
 * BottomRight, …) carries the vertical axis as a fallback.
 *   - Intake / Inlet  → Front (air enters the front)
 *   - Exhaust / Outlet → Back  (air exits the back)
 * When only one axis is known we show that; when neither is recognised
 * we fall back to the firmware label untouched (no doubling).
 */
function prettyTempLabel(pos: string, rawLabel?: string): string {
  const label = (rawLabel ?? pos).trim();
  const lower = label.toLowerCase();
  const posLower = pos.toLowerCase();

  const vertical =
    lower.includes('top') || posLower.startsWith('top')
      ? 'Top'
      : lower.includes('bottom') || posLower.startsWith('bottom')
        ? 'Bottom'
        : null;

  const side =
    lower.includes('intake') || lower.includes('inlet')
      ? 'Front'
      : lower.includes('exhaust') || lower.includes('outlet')
        ? 'Back'
        : null;

  if (vertical && side) return `${vertical} ${side}`;
  if (side) return side;
  if (vertical) return vertical;
  return label;
}

function TempCell({ label, value }: { label: string; value: number | null }) {
  if (value === null) {
    return (
      <div className="flex flex-col">
        <span className="text-[10px] text-muted-foreground">{label}</span>
        <span className="text-sm text-muted-foreground">—</span>
      </div>
    );
  }
  const tone = tempTone(value);
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-semibold tabular-nums', toneClass(tone))}>
        {fmtNum(value, 0)}
        <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">°C</span>
      </span>
    </div>
  );
}

// ----- helpers --------------------------------------------------------

function sum(arr: Array<number | null>): number | null {
  const vals = arr.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0);
}

function avg(arr: Array<number | null>): number | null {
  const vals = arr.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function trendFor(actual: number | null, nominal: number | null): 'up' | 'down' | null {
  if (actual === null || nominal === null || nominal <= 0) return null;
  // Within 2% of nominal is "OK" — use up arrow; otherwise down.
  return actual >= nominal * 0.98 ? 'up' : 'down';
}

function toneClass(tone: ReturnType<typeof tempTone>): string {
  return tone === 'critical' ? 'text-destructive'
    : tone === 'hot' ? 'text-orange-400'
    : tone === 'warm' ? 'text-amber-400'
    : 'text-foreground';
}
