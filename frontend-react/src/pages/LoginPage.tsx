import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cpu } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';

// Login page for the optional password protection (auth.enabled = true
// in settings). Mirrors the vanilla /login behaviour:
//   - POSTs the password to /api/auth/login
//   - on success, FastAPI sets the mw_token cookie and we redirect to
//     either the `next` query param or the dashboard
//   - on a 429 the backend tells us how many seconds the IP is locked
//     out for; we surface the countdown in the UI

interface LoginResponse {
  status: 'ok';
}

interface LockoutDetail {
  detail: string;
  retry_after?: number;
}

export function LoginPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setPending(true);
    setMessage(null);
    try {
      await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { password },
      });
      const next = params.get('next') ?? '/';
      // Use the browser's location for the post-login redirect so the
      // freshly set cookie is picked up by any subsequent /api call,
      // including the classic vanilla pages.
      window.location.href = next;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          // FastAPI puts the seconds in `detail`. Best-effort parse.
          const match = err.message.match(/(\d+)/);
          const seconds = match ? Number(match[1]) : null;
          setMessage(
            seconds
              ? `Too many attempts. Try again in ${seconds}s.`
              : 'Too many attempts. Try again later.',
          );
        } else {
          setMessage(err.message);
        }
      } else {
        setMessage((err as Error).message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Cpu className="h-6 w-6" />
          </div>
          <CardTitle>MinerWatch</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={pending}
              />
            </div>
            <Button type="submit" className="w-full" disabled={pending || !password}>
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
            {message && (
              <p
                className="text-sm text-center text-destructive"
                role="alert"
                aria-live="polite"
              >
                {message}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// Unused but exported for future use: response shape if we wire the
// frontend to read /api/auth/status during route guards.
export type { LockoutDetail };
