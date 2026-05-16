import { useQuery } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { fmtDifficulty, fmtRelative } from '@/lib/format';

interface PerMinerBest {
  miner_id: number;
  miner_name: string;
  session: { value: number; ts: number; uptime_at_record: number | null } | null;
  alltime: { value: number; ts: number; uptime_at_record: number | null } | null;
}

interface Props {
  minerId: number;
}

/**
 * Per-miner best-share card. Same shape as the fleet card but
 * scoped to one device. Hidden when both scopes are empty (fresh
 * miner that hasn't beaten its DB seed yet).
 */
export function MinerBestShares({ minerId }: Props) {
  const { data } = useQuery({
    queryKey: ['miner-best', minerId],
    queryFn: ({ signal }) =>
      api<PerMinerBest>(`/api/miners/${minerId}/best_difficulty`, { signal }),
    refetchInterval: 5_000,
  });

  if (!data) return null;
  if (!data.session && !data.alltime) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Trophy className="h-4 w-4" />
        </div>
        <div>
          <CardTitle className="text-base">Best share — {data.miner_name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Session resets at miner reboot · all-time persists in MinerWatch
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Tile
            label="Session"
            sub="since the last reboot"
            value={data.session ? fmtDifficulty(data.session.value) : '—'}
            meta={data.session ? fmtRelative(data.session.ts) : 'since the last reboot'}
          />
          <Tile
            label="All-time"
            sub="tracked by MinerWatch"
            value={data.alltime ? fmtDifficulty(data.alltime.value) : '—'}
            meta={data.alltime ? fmtRelative(data.alltime.ts) : 'tracked by MinerWatch'}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Tile({ label, value, meta }: { label: string; sub: string; value: string; meta: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{meta}</div>
    </div>
  );
}
