import { Plus, Radar } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { MinerCard } from './MinerCard';
import type { MinerListEntry } from '@/lib/types';

interface Props {
  miners: MinerListEntry[];
  loading: boolean;
  onAdd: () => void;
  onScan: () => void;
  scanning?: boolean;
}

export function MinerGrid({ miners, loading, onAdd, onScan, scanning }: Props) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/3" />
            <div className="mt-4 grid grid-cols-3 gap-3">
              {Array.from({ length: 6 }).map((_, j) => (
                <Skeleton key={j} className="h-10" />
              ))}
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (!miners.length) {
    return (
      <Card className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <h3 className="text-lg font-semibold">No miners yet</h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          Run an automatic scan of your LAN, or add one by IP/hostname.
        </p>
        <div className="flex gap-2 pt-1">
          <Button onClick={onScan} disabled={scanning}>
            <Radar className="h-4 w-4" />
            {scanning ? 'Scanning…' : 'Auto scan'}
          </Button>
          <Button variant="subtle" onClick={onAdd}>
            <Plus className="h-4 w-4" />
            Add manually
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {miners.map((m) => (
        <MinerCard key={m.id} miner={m} />
      ))}
    </div>
  );
}
