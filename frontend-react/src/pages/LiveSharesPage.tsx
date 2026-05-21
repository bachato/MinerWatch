import { LiveSharesCard } from '@/components/analytics/LiveSharesCard';
import { useMiners } from '@/api/hooks';

/**
 * Dedicated "Live shares" page (its own nav entry, between Analytics and
 * Pools). Renders the real-time per-share scatter + near-block Hall of
 * Fame for AxeOS miners. The card itself owns the SSE subscription, the
 * miner selector and the time-range controls.
 */
export function LiveSharesPage() {
  const { data: minersData } = useMiners();
  const miners = minersData?.miners ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Live shares</h1>
        <p className="text-sm text-muted-foreground">
          Every share in real time, straight from the miner's log — AxeOS only
        </p>
      </header>

      <LiveSharesCard miners={miners} />
    </div>
  );
}
