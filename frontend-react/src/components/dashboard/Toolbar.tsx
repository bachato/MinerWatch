import { Plus, Radar } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface Props {
  pollingSeconds: number | null;
  onAdd: () => void;
  onScan: () => void;
  scanning?: boolean;
}

export function Toolbar({ pollingSeconds, onAdd, onScan, scanning }: Props) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Miner fleet</h1>
        <p className="text-sm text-muted-foreground">
          Polling every{' '}
          {pollingSeconds && pollingSeconds > 0 ? (
            <span className="font-medium text-foreground">{pollingSeconds}s</span>
          ) : (
            '—s'
          )}{' '}
          · data straight from miners on the LAN
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="subtle" onClick={onScan} disabled={scanning}>
          <Radar className="h-4 w-4" />
          {scanning ? 'Scanning…' : 'Scan network'}
        </Button>
        <Button onClick={onAdd}>
          <Plus className="h-4 w-4" />
          Add miner
        </Button>
      </div>
    </header>
  );
}
