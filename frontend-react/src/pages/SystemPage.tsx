import { Server } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function SystemPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System</h1>
          <p className="text-sm text-muted-foreground">Host metrics (Raspberry Pi)</p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-chart-thermal/15 text-chart-thermal">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>System view migration in progress</CardTitle>
              <CardDescription>
                CPU / RAM / temperature / fan view from the classic /system page.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Classic view at{' '}
            <a className="text-primary hover:underline" href="/system">
              /system
            </a>
            . Shown only when the host is a Raspberry Pi.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
