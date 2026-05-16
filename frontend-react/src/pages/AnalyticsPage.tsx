import { BarChart3 } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Statistical predictions and historical records
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-chart-mining/15 text-chart-mining">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Predictions and leaderboard coming next</CardTitle>
              <CardDescription>
                Same widgets as the classic /analytics page, rendered with the new design system.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The classic Analytics page is available at{' '}
            <a className="text-primary hover:underline" href="/analytics">
              /analytics
            </a>{' '}
            and stays the canonical view until this one reaches feature parity.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
