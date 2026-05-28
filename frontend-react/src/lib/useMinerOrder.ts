import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Persisted custom order for the dashboard miner grid.
//
// Contract:
//   - The order is an array of miner IDs, stored in localStorage as
//     JSON under MW_ORDER_KEY. Any ID not present in the array is
//     considered "unordered" and appears AFTER the ordered IDs, in
//     whatever order the API returned (i.e. the default order).
//   - Newly discovered miners (auto-scan, manual add) therefore land
//     at the bottom without disturbing the user's curated layout.
//   - Removed miners get pruned silently the next time the hook sees
//     a list that no longer contains them — so we never accumulate
//     orphan IDs.
//
// This is kept *local* on purpose: the order is a per-device UI
// preference, not data the backend cares about. If we later want
// cross-device sync we can mirror MW_ORDER_KEY into a /api/ui-prefs
// endpoint without changing the call sites.

const MW_ORDER_KEY = 'mw-miner-order';

function readStored(): number[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(MW_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Guard against accidentally-stored junk (strings, objects).
    return parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  } catch {
    return [];
  }
}

function writeStored(order: number[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MW_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Private-mode Safari etc. — drop silently; the in-memory state
    // still applies for the rest of the session.
  }
}

export interface UseMinerOrderResult<T> {
  /** Miners re-ordered according to the persisted preference. Same
   *  references as the input array (just shuffled). */
  ordered: T[];
  /** Apply a new ordering via the *displayed* index pair. Both
   *  indexes refer to positions in ``ordered``. */
  reorder: (fromIndex: number, toIndex: number) => void;
  /** Reset to the API order. */
  reset: () => void;
}

/**
 * Hook factory: given the canonical list from the API and an ID
 * accessor, returns the same list sorted by the persisted custom
 * order. The hook self-heals against added/removed miners: new IDs
 * are appended in API order, removed IDs are pruned from the stored
 * preference.
 */
export function useMinerOrder<T extends { id: number }>(items: T[]): UseMinerOrderResult<T> {
  const [order, setOrder] = useState<number[]>(readStored);
  // Cross-tab sync: when another tab reorders, mirror the change
  // here so a multi-window MinerWatch session stays coherent.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== MW_ORDER_KEY) return;
      setOrder(readStored());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Whenever the API list changes, prune IDs that no longer exist
  // (the user deleted a miner) and ensure new IDs are NOT injected
  // into the stored order — they show up at the bottom via the
  // ``ordered`` derivation below. Pruning is the only mutation here.
  const lastPruneSig = useRef('');
  useEffect(() => {
    const valid = new Set(items.map((m) => m.id));
    const pruned = order.filter((id) => valid.has(id));
    // Avoid setState loops: only write if something actually changed.
    const sig = pruned.join(',');
    if (sig === lastPruneSig.current) return;
    lastPruneSig.current = sig;
    if (pruned.length !== order.length) {
      setOrder(pruned);
      writeStored(pruned);
    }
  }, [items, order]);

  const ordered = useMemo<T[]>(() => {
    if (!items.length) return items;
    const byId = new Map<number, T>(items.map((m) => [m.id, m] as const));
    const seen = new Set<number>();
    const out: T[] = [];
    // First: items the user has explicitly ordered, in stored order.
    for (const id of order) {
      const item = byId.get(id);
      if (item && !seen.has(id)) {
        out.push(item);
        seen.add(id);
      }
    }
    // Then: items not yet in the stored order, in their original
    // (API) order. New miners therefore append to the end.
    for (const item of items) {
      if (!seen.has(item.id)) out.push(item);
    }
    return out;
  }, [items, order]);

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      // Compute the new full order from the *displayed* sequence so
      // that previously-unordered items get baked into the preference
      // on first move (otherwise dragging an "unordered" miner would
      // not persist relative to the others).
      const currentIds = ordered.map((m) => m.id);
      if (fromIndex < 0 || fromIndex >= currentIds.length) return;
      if (toIndex < 0 || toIndex >= currentIds.length) return;
      const next = [...currentIds];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      setOrder(next);
      writeStored(next);
    },
    [ordered],
  );

  const reset = useCallback(() => {
    setOrder([]);
    writeStored([]);
  }, []);

  return { ordered, reorder, reset };
}
