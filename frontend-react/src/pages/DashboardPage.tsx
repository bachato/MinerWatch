import { Activity } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Placeholder for the migrated dashboard. The real content (fleet
// summary, miner cards, hashrate chart, alerts, best-share card,
// block-finds trophy) will land here in the next session.
//
// While this page is empty, the vanilla dashboard at /  remains the
// canonical view. As soon as feature parity is reached we redirect the
// vanilla route to /v2/.

export function DashboardPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Miner fleet · live LAN data</p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Dashboard migration in progress</CardTitle>
              <CardDescription>
                Phase 1 (theme + shell) is live. Phase 2 will port the fleet view here.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The classic dashboard is still available at{' '}
            <a className="text-primary hover:underline" href="/">
              the original /
            </a>{' '}
            while this React version is being built. Both share the same backend, so a miner you
            add in one shows up in the other.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
