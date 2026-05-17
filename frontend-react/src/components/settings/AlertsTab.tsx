import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useAckAlert, useAllAlerts } from '@/api/hooks';
import { useState } from 'react';
import type { AlertSeverity } from '@/lib/types';
import type { SettingsFormState } from './SettingsForm';

interface Props {
  form: SettingsFormState;
  setForm: (next: SettingsFormState) => void;
}

export function AlertsTab({ form, setForm }: Props) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alert thresholds</CardTitle>
          <CardDescription>
            When a temperature exceeds the threshold or a miner goes offline for too long.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumField
            id="alerts.temp_chip_threshold"
            label="Max chip temp (°C)"
            value={form.tempChip}
            min={40}
            max={120}
            step={0.5}
            onChange={(v) => setForm({ ...form, tempChip: v })}
          />
          <NumField
            id="alerts.temp_vr_threshold"
            label="Max VR temp (°C)"
            value={form.tempVr}
            min={40}
            max={130}
            step={0.5}
            onChange={(v) => setForm({ ...form, tempVr: v })}
          />
          <NumField
            id="alerts.offline_threshold_seconds"
            label="Offline threshold (seconds)"
            value={form.offlineSeconds}
            min={10}
            max={3600}
            onChange={(v) => setForm({ ...form, offlineSeconds: v })}
          />
          <NumField
            id="alerts.repeat_seconds"
            label="Repeat alert every (seconds)"
            value={form.repeatSeconds}
            min={60}
            max={86400}
            onChange={(v) => setForm({ ...form, repeatSeconds: v })}
          />

          <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 sm:col-span-2">
            <div>
              <div className="text-sm font-semibold">Send push notifications</div>
              <p className="text-xs text-muted-foreground">
                Global kill-switch. When off, MinerWatch keeps recording alerts but doesn't push
                them on any channel. Existing browser subscriptions stay registered.
              </p>
            </div>
            <Switch
              checked={form.notificationsEnabled}
              onCheckedChange={(v) => setForm({ ...form, notificationsEnabled: v })}
            />
          </div>

          <p className="text-xs text-muted-foreground sm:col-span-2">
            If the condition persists (temp still above threshold, miner still offline), MinerWatch
            re-emits the alert every "Repeat alert every" seconds (default 600 = 10 min).
          </p>
        </CardContent>
      </Card>

      <AlertHistoryCard />
    </div>
  );
}

interface NumFieldProps {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}

function NumField({ id, label, value, min, max, step, onChange }: NumFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function AlertHistoryCard() {
  const { data } = useAllAlerts(50);
  const ack = useAckAlert();
  const [busyId, setBusyId] = useState<number | null>(null);

  const alerts = data?.alerts ?? [];
  const severityVariant = (s: AlertSeverity) =>
    s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'secondary';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Alert history</CardTitle>
        <CardDescription>Last 50 alerts, newest first. Acknowledge to clear unread state.</CardDescription>
      </CardHeader>
      <CardContent>
        {!alerts.length ? (
          <p className="text-sm text-muted-foreground">No alerts.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-medium">When</th>
                  <th className="px-2 py-2 text-left font-medium">Severity</th>
                  <th className="px-2 py-2 text-left font-medium">Code</th>
                  <th className="px-2 py-2 text-left font-medium">Message</th>
                  <th className="px-2 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-b border-border/40 last:border-0">
                    <td className="px-2 py-2 tabular-nums text-muted-foreground whitespace-nowrap">
                      {new Date(a.ts * 1000).toLocaleString()}
                    </td>
                    <td className="px-2 py-2">
                      <Badge variant={severityVariant(a.severity)}>{a.severity}</Badge>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">{a.code}</td>
                    <td className="px-2 py-2">{a.message}</td>
                    <td className="px-2 py-2 text-right">
                      {a.acknowledged ? (
                        <span className="text-emerald-400">✓</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="subtle"
                          disabled={busyId === a.id}
                          onClick={() => {
                            setBusyId(a.id);
                            ack.mutate(a.id, { onSettled: () => setBusyId(null) });
                          }}
                        >
                          {busyId === a.id ? '…' : 'Ack'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
