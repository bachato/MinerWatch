import { useState } from 'react';

import { Toolbar } from '@/components/dashboard/Toolbar';
import { CriticalBanner } from '@/components/dashboard/CriticalBanner';
import { AlertsBanner } from '@/components/dashboard/AlertsBanner';
import { FleetSummary } from '@/components/dashboard/FleetSummary';
import { BlockFindsCard } from '@/components/dashboard/BlockFindsCard';
import { BestSharesCard } from '@/components/dashboard/BestSharesCard';
import { FleetHashrateChart } from '@/components/dashboard/FleetHashrateChart';
import { MinerGrid } from '@/components/dashboard/MinerGrid';
import { AddMinerDialog } from '@/components/dashboard/AddMinerDialog';
import { useMiners, useScanNetwork, useSettings } from '@/api/hooks';

/**
 * Migrated dashboard.
 *
 * Layout (top to bottom):
 *   - Toolbar  · titles + Scan / Add miner buttons
 *   - Critical bar  · only when at least one temp is over threshold
 *   - Unread alerts bar  · only when there are unack alerts
 *   - Fleet KPIs (5 cards)  · online · hashrate · power · efficiency · max temp
 *   - Block-finds trophy  · only after a solo block has been mined
 *   - Best-share fleet card  · session + all-time
 *   - Fleet hashrate chart  · last hour, 1-min buckets
 *   - Miner grid  · cards linking to /miner/:id (or empty-state CTA)
 *   - Add miner dialog (modal)
 *
 * The legacy /api/* polling cadence (5 s) is preserved automatically by
 * the TanStack Query hooks — every component reading the same query
 * shares the same network call.
 */
export function DashboardPage() {
  const [addOpen, setAddOpen] = useState(false);

  const { data: minersData, isLoading: minersLoading } = useMiners();
  const { data: settingsData } = useSettings();
  const scanMutation = useScanNetwork();

  const miners = minersData?.miners ?? [];
  const settings = settingsData?.current ?? null;
  const pollingSeconds = settings?.polling?.interval_seconds ?? null;

  return (
    <div className="space-y-5">
      <Toolbar
        pollingSeconds={pollingSeconds}
        onAdd={() => setAddOpen(true)}
        onScan={() => scanMutation.mutate()}
        scanning={scanMutation.isPending}
      />

      <CriticalBanner miners={miners} settings={settings} />
      <AlertsBanner />

      <FleetSummary miners={miners} />

      <BlockFindsCard />
      <BestSharesCard />
      <FleetHashrateChart />

      <MinerGrid
        miners={miners}
        loading={minersLoading}
        onAdd={() => setAddOpen(true)}
        onScan={() => scanMutation.mutate()}
        scanning={scanMutation.isPending}
      />

      <AddMinerDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
