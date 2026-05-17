import { useState } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useLogout } from '@/api/hooks';
import { ApiError } from '@/lib/api';
import type { SettingsFormState } from './SettingsForm';

interface Props {
  form: SettingsFormState;
  setForm: (next: SettingsFormState) => void;
}

export function SecurityTab({ form, setForm }: Props) {
  const logout = useLogout();
  const [error, setError] = useState<string | null>(null);

  async function handleLogout() {
    if (!confirm('Log out from this browser?')) return;
    setError(null);
    try {
      await logout.mutateAsync();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
    // Same UX as the vanilla page: redirect regardless, so a stale
    // session can't keep operating.
    window.location.href = '/login';
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-chart-performance/15 text-chart-performance">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">Password protection</CardTitle>
            <CardDescription>
              Disabled by default. When enabled, MinerWatch requires the password on each login.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
          <div>
            <div className="text-sm font-semibold">Require a password</div>
            <p className="text-xs text-muted-foreground">
              Sessions use the <code className="rounded bg-muted px-1">mw_token</code> cookie or an
              <code className="ml-1 rounded bg-muted px-1">Authorization: Bearer</code> header.
            </p>
          </div>
          <Switch
            checked={form.authEnabled}
            onCheckedChange={(v) => setForm({ ...form, authEnabled: v })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="auth.password">Password</Label>
          <Input
            id="auth.password"
            type="password"
            placeholder="••••••••"
            value={form.authPassword}
            onChange={(e) => setForm({ ...form, authPassword: e.target.value })}
            autoComplete="new-password"
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to keep the existing password. The current one is never returned by the API.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
          <Button variant="destructive" onClick={handleLogout} disabled={logout.isPending}>
            <LogOut className="h-4 w-4" />
            {logout.isPending ? 'Signing out…' : 'Log out'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Clears the session cookie on this browser. Other devices stay logged in.
          </p>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
