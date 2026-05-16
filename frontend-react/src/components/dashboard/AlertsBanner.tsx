import { Bell, BellRing } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAckAllAlerts, useUnackAlerts } from '@/api/hooks';

/**
 * Compact bar showing unread alert count + the latest message. Severity
 * drives the colour: critical = red, warning = amber, info = neutral.
 * "Mark all as read" calls the existing /api/alerts/{id}/ack endpoint
 * for each entry in parallel (same as the vanilla page).
 */
export function AlertsBanner() {
  const { data } = useUnackAlerts();
  const ack = useAckAllAlerts();

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

  return (
    <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${tone}`}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="font-medium">
        {alerts.length} unread alert{alerts.length === 1 ? '' : 's'}
      </span>
      <span className="truncate opacity-90">· {last.message}</span>
      <Button
        type="button"
        size="sm"
        variant="subtle"
        className="ml-auto whitespace-nowrap"
        disabled={ack.isPending}
        onClick={() => ack.mutate()}
      >
        {ack.isPending ? 'Marking…' : 'Mark all as read'}
      </Button>
    </div>
  );
}
