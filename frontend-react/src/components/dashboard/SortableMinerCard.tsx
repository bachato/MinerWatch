import type { CSSProperties } from 'react';
import { GripVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { cn } from '@/lib/utils';
import { MinerCard } from './MinerCard';
import type { MinerListEntry } from '@/lib/types';

interface Props {
  miner: MinerListEntry;
}

/**
 * Drag-and-drop wrapper around <MinerCard>.
 *
 * The card itself stays wrapped in a router <Link> (click-to-open),
 * so we cannot put the drag listeners on it — a button inside an
 * <a> is invalid HTML, and listeners on the link would race with
 * navigation. Instead we render the unmodified card and a sibling
 * <button> grip handle inside a relative wrapper. Only the grip
 * activates the drag; clicking anywhere else still navigates.
 *
 * The grip lives in the top-left corner with reduced opacity to
 * keep it from competing with the StatusBadge in the top-right;
 * it brightens on hover/focus so it remains discoverable.
 */
export function SortableMinerCard({ miner }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: miner.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Float the card a bit while dragging so it visually lifts above
    // its siblings; also fade it slightly so the drop target shows.
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={style} className="relative touch-manipulation">
      <MinerCard miner={miner} />
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${miner.name}`}
        title="Drag to reorder"
        // Sit on top of the card without intercepting the link's hit
        // area — only the handle's own footprint takes pointer events.
        // Always-visible variant: the handle is part of the card now,
        // not a hover affordance. MinerCard's header reserves the
        // left gutter so the miner name sits right after it.
        className={cn(
          'absolute left-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md',
          'text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'cursor-grab active:cursor-grabbing',
        )}
        // Make the handle activatable by keyboard without firing the
        // parent link's navigation when pressed (Space / Enter on the
        // button stays within the button).
        onClick={(e) => e.preventDefault()}
      >
        <GripVertical className="h-4 w-4" />
      </button>
    </div>
  );
}
