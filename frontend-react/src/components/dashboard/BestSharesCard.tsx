import { Link } from 'react-router-dom';
import { Trophy } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtDifficulty, fmtRelative } from '@/lib/format';
import { useFleetBest, useMiners } from '@/api/hooks';

/**
 * Two-tile card showing the fleet-wide best share for two scopes:
 *   - Session: best since the leading miner's last reboot
 *   - All-time: best ever observed by MinerWatch, persisted in our DB
 *
 * Hidden when both scopes are empty (fresh install with no shares yet).
 */
export function BestSharesCard() {
  const { data } = useFleetBest();
  const { data: minersData } = useMiners();

  const session = data?.session ?? null;
  const alltime = data?.alltime ?? null;
  if (!session && !alltime) return null;

  const minerLink = (id: number, fallback: string) => {
    const m = minersData?.miners.find((x) => x.id === id);
    const name = m?.name ?? fallback;
    return (
      <Link to={`/miner/${id}`} className="text-primary hover:underline">
        {name}
      </Link>
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Trophy className="h-4 w-4" />
        </div>
        <div>
          <CardTitle className="text-base">Best share — fleet</CardTitle>
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
            value={session ? fmtDifficulty(session.value) : '—'}
            meta={
              session ? (
                <>
                  {minerLink(session.miner_id, `Miner #${session.miner_id}`)} ·{' '}
                  {fmtRelative(session.ts)}
                </>
              ) : (
                'since the last reboot'
              )
            }
          />
          <Tile
            label="All-time"
            sub="tracked by MinerWatch"
            value={alltime ? fmtDifficulty(alltime.value) : '—'}
            meta={
              alltime ? (
                <>
                  {minerLink(alltime.miner_id, `Miner #${alltime.miner_id}`)} ·{' '}
                  {fmtRelative(alltime.ts)}
                </>
              ) : (
                'tracked by MinerWatch'
              )
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

interface TileProps {
  label: string;
  sub: string;
  value: string;
  meta: React.ReactNode;
}

function Tile({ label, value, meta }: TileProps) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{meta}</div>
    </div>
  );
}
