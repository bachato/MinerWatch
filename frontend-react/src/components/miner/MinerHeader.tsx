import { useState } from 'react';
import { ArrowLeft, Power, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import { useDeleteMiner, useRestartMiner } from '@/api/hooks';
import { FAMILY_LABEL } from '@/lib/format';
import type { MinerDetailResponse } from '@/lib/types';

interface Props {
  data: MinerDetailResponse;
}

export function MinerHeader({ data }: Props) {
  const navigate = useNavigate();
  const restart = useRestartMiner();
  const remove = useDeleteMiner();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { miner } = data;
  const familyLabel = FAMILY_LABEL[miner.family] ?? miner.family;
  const subtitleParts = [
    familyLabel,
    `${miner.host}${miner.port ? `:${miner.port}` : ''}`,
    miner.mac,
  ].filter(Boolean);

  async function doRestart() {
    setError(null);
    try {
      await restart.mutateAsync(miner.id);
      setRestartOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function doDelete() {
    setError(null);
    try {
      await remove.mutateAsync(miner.id);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <Button asChild variant="ghost" size="icon" className="-ml-1 mt-0.5">
            <Link to="/" aria-label="Back to dashboard">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{miner.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {subtitleParts.join(' · ')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="subtle" onClick={() => setRestartOpen(true)}>
            <Power className="h-4 w-4" /> Restart
          </Button>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            <Trash2 className="h-4 w-4" /> Remove
          </Button>
        </div>
      </header>

      <Dialog open={restartOpen} onOpenChange={setRestartOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart {miner.name}?</DialogTitle>
            <DialogDescription>
              The miner reboots and is unreachable for ~30 seconds. Historical metrics are
              preserved.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRestartOpen(false)} disabled={restart.isPending}>
              Cancel
            </Button>
            <Button onClick={doRestart} disabled={restart.isPending}>
              {restart.isPending ? 'Sending…' : 'Restart'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {miner.name}?</DialogTitle>
            <DialogDescription>
              This deletes the device registration and all historical metrics for this miner.
              The miner itself keeps running on the LAN — you can re-add it later via Scan
              network or Add miner. <strong>This action cannot be undone.</strong>
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={remove.isPending}>
              {remove.isPending ? 'Removing…' : 'Remove permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
