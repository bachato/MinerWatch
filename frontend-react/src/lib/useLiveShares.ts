import { useEffect, useState } from 'react';

import type { LiveShareEvent, LiveSharesStats } from '@/lib/types';

// Subscribes to the backend SSE stream of live share events for one
// AxeOS miner (GET /api/miners/:id/shares/stream). EventSource sends
// the session cookie same-origin, so this works with auth enabled.
//
// The server emits three event kinds:
//   - "snapshot": the current ring buffer + cumulative stats (sent once
//      on connect, and again after any reconnect).
//   - "share":    one new ASIC result.
//   - "verdict":  the pool's accept/reject for a previously-submitted
//      share (matched by `seq`).
//
// We keep at most MAX_EVENTS in memory; the chart windows further.

const MAX_EVENTS = 2000;

export interface LiveSharesState {
  events: LiveShareEvent[];
  stats: LiveSharesStats | null;
  connected: boolean;
}

// Backend sends ts in epoch seconds; charts want milliseconds.
function toMs(e: LiveShareEvent): LiveShareEvent {
  return { ...e, ts: e.ts * 1000 };
}

export function useLiveShares(minerId: number | undefined): LiveSharesState {
  const [events, setEvents] = useState<LiveShareEvent[]>([]);
  const [stats, setStats] = useState<LiveSharesStats | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!Number.isInteger(minerId)) return;

    // Reset on miner change so the previous device's points don't bleed
    // into the new chart.
    setEvents([]);
    setStats(null);
    setConnected(false);

    const es = new EventSource(`/api/miners/${minerId}/shares/stream`);

    es.addEventListener('snapshot', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        const evs: LiveShareEvent[] = (payload.events ?? []).map(toMs);
        setEvents(evs.slice(-MAX_EVENTS));
        setStats(payload.stats ?? null);
        setConnected(true);
      } catch {
        /* ignore malformed frame */
      }
    });

    es.addEventListener('share', (ev) => {
      try {
        const e = toMs(JSON.parse((ev as MessageEvent).data));
        setEvents((prev) => {
          const next = prev.length >= MAX_EVENTS ? prev.slice(prev.length - MAX_EVENTS + 1) : prev.slice();
          next.push(e);
          return next;
        });
        setStats((prev) =>
          prev
            ? {
                ...prev,
                results_total: prev.results_total + 1,
                submitted_total: prev.submitted_total + (e.submitted ? 1 : 0),
                current_target: e.target,
                last_event_ts: e.ts / 1000,
              }
            : prev,
        );
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('verdict', (ev) => {
      try {
        const v = JSON.parse((ev as MessageEvent).data) as { seq: number; accepted: boolean };
        setEvents((prev) => prev.map((e) => (e.seq === v.seq ? { ...e, accepted: v.accepted } : e)));
        setStats((prev) =>
          prev
            ? {
                ...prev,
                accepted_total: prev.accepted_total + (v.accepted ? 1 : 0),
                rejected_total: prev.rejected_total + (v.accepted ? 0 : 1),
              }
            : prev,
        );
      } catch {
        /* ignore */
      }
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
    };
  }, [minerId]);

  return { events, stats, connected };
}
