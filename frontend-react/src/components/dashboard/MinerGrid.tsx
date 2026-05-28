import { Plus, Radar } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SortableMinerCard } from './SortableMinerCard';
import { useMinerOrder } from '@/lib/useMinerOrder';
import type { MinerListEntry } from '@/lib/types';

interface Props {
  miners: MinerListEntry[];
  loading: boolean;
  onAdd: () => void;
  onScan: () => void;
  scanning?: boolean;
}

/**
 * Fleet grid with drag-and-drop reordering.
 *
 * Order is persisted client-side (see ``useMinerOrder``); new miners
 * append to the end of the displayed list, removed miners are pruned
 * from the stored preference silently.
 *
 * Sensor configuration is conservative on purpose:
 *   - PointerSensor with a 6 px activation distance, so a normal
 *     click on the grip handle (or anywhere else) still opens the
 *     miner page; only a real drag motion triggers reordering.
 *   - TouchSensor with a 150 ms press delay, which gives mobile
 *     users time to scroll the page without accidentally picking
 *     up a card.
 *   - KeyboardSensor with the sortable coordinate getter so the
 *     grip handle is fully reorderable via arrow keys for users
 *     who don't have a pointer.
 */
export function MinerGrid({ miners, loading, onAdd, onScan, scanning }: Props) {
  const { ordered, reorder } = useMinerOrder(miners);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = ordered.map((m) => m.id);
    const fromIndex = ids.indexOf(Number(active.id));
    const toIndex = ids.indexOf(Number(over.id));
    if (fromIndex === -1 || toIndex === -1) return;
    // arrayMove is only used here for symmetry / clarity — the hook
    // does its own splice based on indexes, so we just hand it the
    // before/after positions.
    void arrayMove;
    reorder(fromIndex, toIndex);
  }

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

  if (!ordered.length) {
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
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ordered.map((m) => m.id)} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {ordered.map((m) => (
            <SortableMinerCard key={m.id} miner={m} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
