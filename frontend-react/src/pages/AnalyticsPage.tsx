import { BarChart3 } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PredictionsCard } from '@/components/analytics/PredictionsCard';
import { TopSharesCard } from '@/components/analytics/TopSharesCard';
import { useFleetBestTop, useFleetPrediction, useMiners } from '@/api/hooks';

export function AnalyticsPage() {
  const { data: predData } = useFleetPrediction();
  const { data: topData } = useFleetBestTop('alltime', 10);
  const { data: minersData } = useMiners();

  const prediction = predData ?? null;
  const top = topData ?? null;
  const miners = minersData?.miners ?? [];

  const predVisible = !!(prediction && prediction.fleet_hashrate_ths && prediction.best_alltime);
  const topVisible = !!top?.entries?.length;
  const anythingVisible = predVisible || topVisible;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Statistical predictions and historical records
        </p>
      </header>

      <PredictionsCard data={prediction} />
      <TopSharesCard data={top} miners={miners} />

      {!anythingVisible && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-chart-mining/15 text-chart-mining">
                <BarChart3 className="h-5 w-5" />
              </div>
              <div>
                <CardTitle>No data yet</CardTitle>
                <CardDescription>Add a miner and let it run for a few minutes</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              As soon as a miner accepts its first share, Predictions and the Top best shares
              leaderboard populate automatically. Head over to{' '}
              <a className="text-primary hover:underline" href="/">
                the Dashboard
              </a>{' '}
              to add one if you haven't already.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
