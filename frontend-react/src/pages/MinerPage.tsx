import { useParams } from 'react-router-dom';
import { Cpu } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function MinerPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Miner #{id}</h1>
          <p className="text-sm text-muted-foreground">Per-device live data and controls</p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-chart-hardware/15 text-chart-hardware">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Miner detail migration in progress</CardTitle>
              <CardDescription>
                Tabs Overview / Hardware / History / Controls will land in the next session.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Until then, use the classic page at{' '}
            <a className="text-primary hover:underline" href={`/miner/${id}`}>
              /miner/{id}
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
