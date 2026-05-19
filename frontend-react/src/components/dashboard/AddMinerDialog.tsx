import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAddMiner } from '@/api/hooks';
import { ApiError } from '@/lib/api';
import type { MinerFamily } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Manual "Add miner" form. Submits to POST /api/miners.
 *
 * Form quirks to preserve from the vanilla page:
 *   - port is optional; the driver defaults to 80 (Bitaxe) or 4028
 *     (cgminer-based) when left blank
 *   - name is optional; the backend autogenerates one from the family
 *     and host if absent
 */
export function AddMinerDialog({ open, onOpenChange }: Props) {
  const [family, setFamily] = useState<MinerFamily>('bitaxe');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const addMiner = useAddMiner();

  function reset() {
    setFamily('bitaxe');
    setHost('');
    setPort('');
    setName('');
    setNotes('');
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!host.trim()) {
      setError('Host or IP is required.');
      return;
    }
    try {
      await addMiner.mutateAsync({
        family,
        host: host.trim(),
        port: port ? Number(port) : null,
        name: name.trim() || null,
        notes: notes.trim() || null,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add miner</DialogTitle>
          <DialogDescription>
            Connects to a miner on your LAN by hostname or IP. Auto-discovery still works after
            this — the new entry just gets registered immediately.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="family">Family</Label>
              <select
                id="family"
                value={family}
                onChange={(e) => setFamily(e.target.value as MinerFamily)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="bitaxe">Bitaxe / NerdQAxe</option>
                <option value="nerdoctaxe">NerdOctaxe (8-ASIC)</option>
                <option value="canaan">Canaan / Avalon</option>
                <option value="braiins">Braiins / BMM</option>
                <option value="luxos">LuxOS (Antminer)</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                placeholder={family === 'bitaxe' || family === 'nerdoctaxe' ? '80' : '4028'}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="host">Host or IP *</Label>
            <Input
              id="host"
              type="text"
              placeholder="192.168.1.42  or  bitaxe-supra.local"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Name (optional)</Label>
            <Input
              id="name"
              type="text"
              placeholder="Bitaxe Supra · garage"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input
              id="notes"
              type="text"
              placeholder="Free text — visible on the miner detail page"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              disabled={addMiner.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={addMiner.isPending || !host.trim()}>
              {addMiner.isPending ? 'Adding…' : 'Add miner'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
