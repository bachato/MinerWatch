import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpDown, Network } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { fmtRelative, FAMILY_LABEL } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePools } from '@/api/hooks';
import type { PoolRow } from '@/lib/types';

// Fleet-wide view of every pool configured on every miner. One row per
// (miner, pool slot) — the cgminer-family drivers contribute one row
// per pool slot they expose, AxeOS drivers contribute one row for the
// primary slot (and a second for NerdOctaxe's fallback when set).
//
// Column rationale (see the discussion in HANDOFF on why these are the
// columns rather than e.g. "Ping"):
//   * URL / User             — the configured stratum endpoint and the
//                              worker name the firmware is sending.
//   * Status                 — Alive / Dead / Unknown; cgminer-family
//                              drivers give us the explicit flag, AxeOS
//                              has no per-pool flag so we fall back to
//                              the miner's overall live_online state
//                              (no row goes red just because AxeOS
//                              doesn't report Alive/Dead).
//   * Accepted / Rejected /
//     Stale                  — raw share counters. Stale is empty for
//                              AxeOS firmwares that don't surface it.
//   * Reject %               — derived; more actionable than raw counts
//                              because uptimes differ across miners.
//   * Last share             — "X minutes ago" — cross-driver liveness
//                              signal. Empty when the firmware doesn't
//                              expose it (AxeOS family).

type SortKey =
  | 'miner'
  | 'url'
  | 'user'
  | 'status'
  | 'accepted'
  | 'rejected'
  | 'stale'
  | 'reject_pct'
  | 'last_share';

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

// Reject% from accepted/rejected. Returns null when neither counter is
// available, or when accepted+rejected == 0 (avoids division-by-zero
// and the meaningless "0/0 = NaN" reject%).
function rejectPct(row: PoolRow): number | null {
  const a = row.accepted ?? 0;
  const r = row.rejected ?? 0;
  if (row.accepted === null && row.rejected === null) return null;
  if (a + r === 0) return null;
  return (r / (a + r)) * 100;
}

// Combined health pill: Alive/Dead/Unknown plus a degraded modifier
// when reject% > 5 (cgminer's own "unhealthy pool" warning threshold).
// AxeOS rows pass `liveOnline` so we can still render a sensible pill
// without the firmware Alive/Dead flag.
function poolHealth(
  row: PoolRow,
): { label: string; tone: 'success' | 'warning' | 'danger' | 'secondary' } {
  const rPct = rejectPct(row);
  const explicit = (row.status ?? '').toLowerCase();
  const aliveExplicit = explicit === 'alive';
  const deadExplicit = explicit === 'dead';

  if (deadExplicit || row.live_online === false) {
    return { label: 'Dead', tone: 'danger' };
  }
  // Degraded if accepting shares but reject% is uncomfortably high.
  // 5% is conservative — cgminer's own log starts warning around 3%
  // but the noise floor for newly-connected miners is often higher.
  if (rPct !== null && rPct >= 5) {
    return { label: `Degraded · ${rPct.toFixed(1)} %`, tone: 'warning' };
  }
  if (aliveExplicit || row.live_online === true) {
    return { label: 'Alive', tone: 'success' };
  }
  return { label: 'Unknown', tone: 'secondary' };
}

// Sort comparator that puts nulls at the bottom for ascending order
// and at the top for descending, so "no data" rows don't claim the
// most-attention top slots.
function compareNullable(
  a: number | string | null,
  b: number | string | null,
  dir: 'asc' | 'desc',
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') {
    return dir === 'asc' ? a - b : b - a;
  }
  return dir === 'asc'
    ? String(a).localeCompare(String(b))
    : String(b).localeCompare(String(a));
}

function fmtCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString();
}

export function PoolsPage() {
  const { data, isLoading, isError, error } = usePools();
  const [sort, setSort] = useState<SortState>({ key: 'miner', dir: 'asc' });

  const rows = data?.pools ?? [];

  const sortedRows = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      let av: number | string | null;
      let bv: number | string | null;
      switch (sort.key) {
        case 'miner':
          av = a.miner_name?.toLowerCase() ?? '';
          bv = b.miner_name?.toLowerCase() ?? '';
          break;
        case 'url':
          av = a.url?.toLowerCase() ?? null;
          bv = b.url?.toLowerCase() ?? null;
          break;
        case 'user':
          av = a.user?.toLowerCase() ?? null;
          bv = b.user?.toLowerCase() ?? null;
          break;
        case 'status':
          av = poolHealth(a).label;
          bv = poolHealth(b).label;
          break;
        case 'accepted':
          av = a.accepted;
          bv = b.accepted;
          break;
        case 'rejected':
          av = a.rejected;
          bv = b.rejected;
          break;
        case 'stale':
          av = a.stale;
          bv = b.stale;
          break;
        case 'reject_pct':
          av = rejectPct(a);
          bv = rejectPct(b);
          break;
        case 'last_share':
          av = a.last_share_ts;
          bv = b.last_share_ts;
          break;
      }
      return compareNullable(av, bv, sort.dir);
    });
    return out;
  }, [rows, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );
  }

  // Empty state: no miners at all yet. Loading: skeletons.
  if (isLoading) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Pools</h1>
          <p className="text-sm text-muted-foreground">
            Stratum endpoints configured on your miners
          </p>
        </header>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Pools</h1>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Couldn't load pools</CardTitle>
            <CardDescription>
              {error instanceof ApiError ? error.message : 'Network error'}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Pools</h1>
          <p className="text-sm text-muted-foreground">
            Stratum endpoints configured on your miners
          </p>
        </header>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Network className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>No miners yet</CardTitle>
                <CardDescription>
                  Add a miner on the Dashboard and we'll show its pool config
                  here.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pools</h1>
        <p className="text-sm text-muted-foreground">
          Stratum endpoints configured on your miners · live
        </p>
      </header>

      <Card>
        <CardContent className="p-0">
          {/* Horizontal scroll on narrow screens — the table has 9
              columns so it won't fit on a phone. The header sticks at
              the top of the scroll area; rows are clickable to drill
              into the underlying miner. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <Th label="Miner" sortKey="miner" sort={sort} onSort={toggleSort} />
                  <Th label="URL" sortKey="url" sort={sort} onSort={toggleSort} />
                  <Th label="User" sortKey="user" sort={sort} onSort={toggleSort} />
                  <Th label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                  <Th
                    label="Accepted"
                    sortKey="accepted"
                    sort={sort}
                    onSort={toggleSort}
                    align="right"
                  />
                  <Th
                    label="Rejected"
                    sortKey="rejected"
                    sort={sort}
                    onSort={toggleSort}
                    align="right"
                  />
                  <Th
                    label="Stale"
                    sortKey="stale"
                    sort={sort}
                    onSort={toggleSort}
                    align="right"
                  />
                  <Th
                    label="Reject %"
                    sortKey="reject_pct"
                    sort={sort}
                    onSort={toggleSort}
                    align="right"
                  />
                  <Th
                    label="Last share"
                    sortKey="last_share"
                    sort={sort}
                    onSort={toggleSort}
                    align="right"
                  />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, idx) => (
                  <PoolRowView key={`${row.miner_id}-${row.slot ?? idx}-${row.url ?? idx}`} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Stale and Last share are only reported by cgminer-family firmwares
        (Braiins, LuxOS, Avalon). AxeOS-based miners (Bitaxe, NerdQAxe, NerdOctaxe)
        don't expose them, so those cells show "—".
      </p>
    </div>
  );
}

interface ThProps {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}

function Th({ label, sortKey, sort, onSort, align = 'left' }: ThProps) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 font-medium',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {label}
        <ArrowUpDown
          className={cn(
            'h-3 w-3 transition-opacity',
            active ? 'opacity-100' : 'opacity-30',
          )}
        />
      </button>
    </th>
  );
}

function PoolRowView({ row }: { row: PoolRow }) {
  const health = poolHealth(row);
  const rPct = rejectPct(row);
  const familyLabel = FAMILY_LABEL[row.family] ?? row.family;

  return (
    <tr className="border-b border-border/60 last:border-0 hover:bg-muted/20">
      <td className="px-3 py-2 align-top">
        <Link
          to={`/miner/${row.miner_id}`}
          className="font-medium text-foreground hover:text-primary hover:underline"
        >
          {row.miner_name}
        </Link>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{familyLabel}</span>
          {row.active === true && (
            <Badge variant="outline" className="border-primary/40 text-primary">
              active
            </Badge>
          )}
          {row.slot === 'fallback' && row.active !== true && (
            <Badge variant="outline">fallback</Badge>
          )}
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <span className="break-all font-mono text-xs">{row.url ?? '—'}</span>
      </td>
      <td className="px-3 py-2 align-top">
        <span className="break-all text-xs">{row.user ?? '—'}</span>
      </td>
      <td className="px-3 py-2 align-top">
        <Badge variant={health.tone} className="whitespace-nowrap">
          {health.label}
        </Badge>
      </td>
      <td className="px-3 py-2 text-right align-top tabular-nums">
        {fmtCount(row.accepted)}
      </td>
      <td className="px-3 py-2 text-right align-top tabular-nums">
        {fmtCount(row.rejected)}
      </td>
      <td className="px-3 py-2 text-right align-top tabular-nums">
        {fmtCount(row.stale)}
      </td>
      <td className="px-3 py-2 text-right align-top tabular-nums">
        {rPct === null ? '—' : `${rPct.toFixed(2)} %`}
      </td>
      <td className="px-3 py-2 text-right align-top text-muted-foreground">
        {fmtRelative(row.last_share_ts)}
      </td>
    </tr>
  );
}
