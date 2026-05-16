import { Settings as SettingsIcon } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configuration, alerts, notifications and security
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-chart-performance/15 text-chart-performance">
              <SettingsIcon className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Settings migration in progress</CardTitle>
              <CardDescription>
                The four-tab layout from the classic page (General / Alerts / Notifications /
                Security) will be ported here.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            For now use{' '}
            <a className="text-primary hover:underline" href="/settings">
              the classic Settings page
            </a>
            . Anything you change there is shared with this frontend.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
