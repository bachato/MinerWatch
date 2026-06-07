import { useState } from 'react';
import { Bell, BellRing, ChevronDown, ChevronUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAckAllAlerts, useUnackAlerts } from '@/api/hooks';
import { fmtRelative } from '@/lib/format';
import type { AlertEntry } from '@/lib/types';

/**
 * Compact bar showing unread alert count + the latest message. Severity
 * drives the colour: critical = red, warning = amber, info = neutral.
 *
 * "Mark all as read" calls the existing /api/alerts/{id}/ack endpoint for
 * each entry in parallel. "Show all" expands the bar into the full list of
 * alerts that fired since the last time they were marked read (the same
 * unacked set the count is based on), each with its relative time.
 */
export function AlertsBanner() {
  const { data } = useUnackAlerts();
  const ack = useAckAllAlerts();
  const [expanded, setExpanded] = useState(false);

  const alerts = data?.alerts ?? [];
  if (!alerts.length) return null;
  const last = alerts[0];

  const tone =
    last.severity === 'critical'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : last.severity === 'warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : 'border-border bg-card text-foreground';

  const Icon = last.severity === 'critical' ? BellRing : Bell;
  const canExpand = alerts.length > 1;

  return (
    <div className={`rounded-lg border text-sm ${tone}`}>
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="h-4 w-4 shrink-0" />
          <span className="font-medium whitespace-nowrap">
            {alerts.length} unread alert{alerts.length === 1 ? '' : 's'}
          </span>
          {!expanded && (
            <span className="min-w-0 truncate opacity-90">· {last.message}</span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          {canExpand && (
            <Button
              type="button"
              size="sm"
              variant="subtle"
              className="flex-1 whitespace-nowrap sm:flex-initial"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
              {expanded ? 'Hide' : `Show all (${alerts.length})`}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="subtle"
            className="flex-1 whitespace-nowrap sm:flex-initial"
            disabled={ack.isPending}
            onClick={() => ack.mutate()}
          >
            {ack.isPending ? 'Marking…' : 'Mark all as read'}
          </Button>
        </div>
      </div>

      {expanded && (
        <ul className="max-h-64 overflow-y-auto border-t border-border/60">
          {alerts.map((a) => (
            <AlertRow key={a.id} alert={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AlertRow({ alert }: { alert: AlertEntry }) {
  const dot =
    alert.severity === 'critical'
      ? 'bg-destructive'
      : alert.severity === 'warning'
        ? 'bg-amber-400'
        : 'bg-muted-foreground';
  return (
    <li className="flex items-start gap-2 border-t border-border/40 px-4 py-2 first:border-t-0">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1 break-words text-foreground">
        {alert.message}
      </span>
      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
        {fmtRelative(alert.ts)}
      </span>
    </li>
  );
}
