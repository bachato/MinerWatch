import { Link } from 'react-router-dom';
import { Medal } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtDifficulty, fmtRelative, FAMILY_LABEL } from '@/lib/format';
import type { BestRecordsTopResponse, MinerListEntry } from '@/lib/types';

interface Props {
  data: BestRecordsTopResponse | null;
  miners: MinerListEntry[];
}

/**
 * All-time best-share leaderboard, one row per enabled miner.
 * Medals on the top 3, family pill on the rest. Hidden when no miner
 * has ever produced a share yet.
 */
export function TopSharesCard({ data, miners }: Props) {
  const entries = data?.entries ?? [];
  if (!entries.length) return null;

  const minerById = new Map(miners.map((m) => [m.id, m]));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-yellow-500/15 text-yellow-400">
          <Medal className="h-4 w-4" />
        </div>
        <div>
          <CardTitle className="text-base">Top best shares</CardTitle>
          <p className="text-xs text-muted-foreground">
            All-time leaderboard across enabled miners
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1">
          <div className="hidden grid-cols-[56px_1fr_140px_120px] gap-3 px-3 py-1 text-[11px] uppercase tracking-wider text-muted-foreground sm:grid">
            <span>#</span>
            <span>Miner</span>
            <span className="text-right">Best</span>
            <span className="text-right">When</span>
          </div>
          {entries.map((e, idx) => {
            const rank = idx + 1;
            const minerRef = minerById.get(e.miner_id);
            const online = minerRef?.live_online === true;
            return (
              <div
                key={`${e.miner_id}-${idx}`}
                className="grid grid-cols-[44px_1fr_120px] sm:grid-cols-[56px_1fr_140px_120px] items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm hover:bg-muted/40 hover:border-border-strong"
              >
                <span className="text-base font-bold">{rankBadge(rank)}</span>
                <div className="min-w-0">
                  <Link
                    to={`/miner/${e.miner_id}`}
                    className="block truncate font-semibold hover:text-primary"
                  >
                    {e.miner_name}
                  </Link>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {online && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                    <span>{FAMILY_LABEL[e.family] ?? e.family}</span>
                  </div>
                </div>
                <span className="text-right text-base font-bold tabular-nums text-primary">
                  {fmtDifficulty(e.value)}
                </span>
                <span className="hidden text-right text-xs tabular-nums text-muted-foreground sm:block">
                  {fmtRelative(e.ts)}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function rankBadge(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}
