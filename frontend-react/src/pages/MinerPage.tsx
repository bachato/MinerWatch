import { useParams, Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { MinerHeader } from '@/components/miner/MinerHeader';
import { MinerBestShares } from '@/components/miner/MinerBestShares';
import { LiveStats } from '@/components/miner/LiveStats';
import { HardwareCards } from '@/components/miner/HardwareCards';
import { Hashboards } from '@/components/miner/Hashboards';
import { HistoryCharts } from '@/components/miner/HistoryCharts';
import { FanControls } from '@/components/miner/FanControls';
import { WorkModeControls } from '@/components/miner/WorkModeControls';
import { GuardianPanel } from '@/components/miner/GuardianPanel';
import { useMiner } from '@/api/hooks';

/**
 * Miner detail page.
 *
 * Tabs (matching the vanilla page after P6 was applied):
 *   - Overview   · current status grid
 *   - Hardware   · 5 grouped readout cards
 *   - History    · hashrate and temperature charts with range selector
 *   - Controls   · fan slider + AUTO + target temperature
 *   - Advanced   · Guardian (runtime frequency governor)
 *
 * URL :id is a path-param. We coerce it to a finite integer before
 * passing it to the hooks — the route should never match without one,
 * but a stray /miner/abc shouldn't crash the page.
 */
export function MinerPage() {
  const { id } = useParams<{ id: string }>();
  const idNum = Number(id);
  const valid = Number.isInteger(idNum) && idNum > 0;

  const { data, isLoading, isError, error } = useMiner(valid ? idNum : undefined);

  if (!valid) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-destructive/15 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Invalid miner id</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button asChild variant="subtle">
            <Link to="/">Back to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-1/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    const message = (error as Error | null)?.message ?? 'Unable to load miner.';
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-destructive/15 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Miner not found</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{message}</p>
          <Button asChild variant="subtle">
            <Link to="/">Back to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <MinerHeader data={data} />
      <MinerBestShares minerId={idNum} />

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="hardware">Hardware</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="controls">Controls</TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-0 space-y-4">
          <LiveStats data={data} />
          {/* Multi-board miners (currently only LuxOS) get the LuxOS-style
              per-hashboard grid right under the overview — this is where
              users coming from the LuxOS dashboard expect to see it.
              The component self-hides on single-board miners. */}
          <Hashboards data={data} />
        </TabsContent>

        <TabsContent value="hardware" className="mt-0 space-y-4">
          <HardwareCards data={data} />
          <Hashboards data={data} />
        </TabsContent>

        <TabsContent value="history" className="mt-0">
          <HistoryCharts minerId={idNum} />
        </TabsContent>

        <TabsContent value="controls" className="mt-0 space-y-4">
          <WorkModeControls data={data} />
          <FanControls data={data} />
        </TabsContent>

        <TabsContent value="advanced" className="mt-0">
          <GuardianPanel data={data} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
