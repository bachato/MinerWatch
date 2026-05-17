import { useEffect, useState } from 'react';
import { Bell, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  usePurgeAllPush,
  useTelegramDiscover,
  useTelegramTest,
  useTestPush,
} from '@/api/hooks';
import { ApiError } from '@/lib/api';
import {
  currentSubscriptionEndpoint,
  pushSupportProblem,
  subscribeThisBrowser,
  unsubscribeThisBrowser,
} from '@/lib/push';
import type { SettingsFormState } from './SettingsForm';

interface Props {
  form: SettingsFormState;
  setForm: (next: SettingsFormState) => void;
}

export function NotificationsTab({ form, setForm }: Props) {
  return (
    <div className="space-y-4">
      <BrowserPushCard form={form} setForm={setForm} />
      <TelegramCard form={form} setForm={setForm} />
    </div>
  );
}

function BrowserPushCard({ form, setForm }: Props) {
  const [subEndpoint, setSubEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const test = useTestPush();
  const purge = usePurgeAllPush();

  const support = pushSupportProblem();

  // Probe the actual subscription state on mount.
  useEffect(() => {
    let cancel = false;
    if (support) return undefined;
    currentSubscriptionEndpoint().then((ep) => {
      if (!cancel) setSubEndpoint(ep);
    });
    return () => {
      cancel = true;
    };
  }, [support]);

  async function handleEnable() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      await subscribeThisBrowser();
      const ep = await currentSubscriptionEndpoint();
      setSubEndpoint(ep);
      setInfo('Notifications enabled on this browser.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      await unsubscribeThisBrowser();
      setSubEndpoint(null);
      setInfo('Notifications disabled on this browser.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setError(null);
    setInfo(null);
    try {
      const r = await test.mutateAsync();
      setInfo(`Test sent to ${r.subscribers} subscriber(s) — check system notifications.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function handlePurge() {
    if (!confirm('Remove ALL push subscriptions from the server? Every device receiving notifications will stop.')) {
      return;
    }
    setError(null);
    setInfo(null);
    try {
      const r = await purge.mutateAsync();
      try {
        await unsubscribeThisBrowser();
      } catch {
        /* no-op: server purge is authoritative */
      }
      setSubEndpoint(null);
      setInfo(`Removed ${r.removed} subscription(s) on the server.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-chart-mining/15 text-chart-mining">
            <Bell className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">Browser push notifications</CardTitle>
            <CardDescription>
              Native OS notifications via Web Push + VAPID. Works as long as the browser stays open.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
          <div>
            <div className="text-sm font-semibold">Send browser push notifications</div>
            <p className="text-xs text-muted-foreground">
              Server-side switch. When off, no push goes out even if browsers are subscribed.
            </p>
          </div>
          <Switch
            checked={form.pushEnabled}
            onCheckedChange={(v) => setForm({ ...form, pushEnabled: v })}
          />
        </div>

        {support ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
            {support}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <div className="text-sm">
              <span className="font-semibold">Status: </span>
              {subEndpoint ? (
                <span className="text-emerald-400">active on this browser</span>
              ) : (
                <span className="text-muted-foreground">not subscribed on this browser</span>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!subEndpoint && !support && (
            <Button onClick={handleEnable} disabled={busy}>
              {busy ? 'Enabling…' : 'Enable notifications'}
            </Button>
          )}
          {subEndpoint && (
            <>
              <Button variant="subtle" onClick={handleTest} disabled={test.isPending}>
                <Send className="h-4 w-4" />
                {test.isPending ? 'Sending…' : 'Send test notification'}
              </Button>
              <Button variant="destructive" onClick={handleDisable} disabled={busy}>
                {busy ? 'Disabling…' : 'Disable (this browser)'}
              </Button>
            </>
          )}
          <Button variant="destructive" onClick={handlePurge} disabled={purge.isPending}>
            {purge.isPending ? 'Purging…' : 'Remove ALL subscriptions'}
          </Button>
        </div>

        {(info || error) && (
          <p className={`text-sm ${error ? 'text-destructive' : 'text-emerald-400'}`} role="status">
            {error ?? info}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          <strong>Heads up:</strong> browsers expose the Web Push API only on <code className="rounded bg-muted px-1">https://</code>{' '}
          or <code className="rounded bg-muted px-1">http://localhost</code>. If you reach MinerWatch from the LAN
          IP from another device, push will show as not supported there — use the Telegram channel below instead.
        </p>
      </CardContent>
    </Card>
  );
}

function TelegramCard({ form, setForm }: Props) {
  const test = useTelegramTest();
  const discover = useTelegramDiscover();
  const [discoverResult, setDiscoverResult] = useState<React.ReactNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function handleTest() {
    setError(null);
    setInfo(null);
    try {
      await test.mutateAsync();
      setInfo('Test sent — check your Telegram app.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function handleDiscover() {
    setError(null);
    setInfo(null);
    setDiscoverResult(<p className="text-sm text-muted-foreground">Asking Telegram for recent chats…</p>);
    try {
      const data = await discover.mutateAsync();
      if (!data.chats.length) {
        setDiscoverResult(
          <div className="space-y-2 text-sm">
            <p>
              No chats yet. Open Telegram, find your bot, send <code className="rounded bg-muted px-1">/start</code>{' '}
              (or any message), then click <strong>Find my chat ID</strong> again.
            </p>
          </div>,
        );
        return;
      }
      setDiscoverResult(
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Click a chat to fill the Chat ID field:</p>
          {data.chats.map((c) => (
            <button
              key={c.chat_id}
              type="button"
              className="block w-full rounded-md border border-border bg-muted/30 p-2 text-left text-sm hover:bg-muted/60"
              onClick={() => {
                setForm({ ...form, telegramChatId: c.chat_id });
                setInfo(`Chat ID set to ${c.chat_id} — click "Save all" to keep it.`);
              }}
            >
              <strong>{c.label}</strong>
              <span className="ml-2 text-xs text-muted-foreground">
                id {c.chat_id} · {c.type}
              </span>
            </button>
          ))}
        </div>,
      );
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setDiscoverResult(
        <div className="space-y-2 text-sm text-destructive">
          <p>❌ {message}</p>
          <p className="text-xs text-muted-foreground">
            Make sure the bot token is saved (click <strong>Save all</strong> first), and that you've sent at
            least one message to the bot from Telegram.
          </p>
        </div>,
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-chart-performance/15 text-chart-performance">
            <Send className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">Telegram notifications</CardTitle>
            <CardDescription>
              Works on any device (iPhone, Android, desktop) without HTTPS — the server is the one calling
              Telegram's API.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
          <div>
            <div className="text-sm font-semibold">Send Telegram notifications</div>
          </div>
          <Switch
            checked={form.telegramEnabled}
            onCheckedChange={(v) => setForm({ ...form, telegramEnabled: v })}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="alerts.telegram_bot_token">Bot token</Label>
            <Input
              id="alerts.telegram_bot_token"
              type="password"
              placeholder="••••••••••••••••"
              autoComplete="off"
              value={form.telegramBotToken}
              onChange={(e) => setForm({ ...form, telegramBotToken: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {form.telegramTokenSet
                ? '✓ token configured — leave empty to keep, fill in to replace'
                : '⚠ no token set — paste the one BotFather gave you'}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="alerts.telegram_chat_id">Chat ID</Label>
            <Input
              id="alerts.telegram_chat_id"
              type="text"
              placeholder="e.g. 123456789 or -1001234567890"
              autoComplete="off"
              value={form.telegramChatId}
              onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={handleTest} disabled={test.isPending}>
            <Send className="h-4 w-4" />
            {test.isPending ? 'Sending…' : 'Send test message'}
          </Button>
          <Button variant="subtle" onClick={handleDiscover} disabled={discover.isPending}>
            {discover.isPending ? 'Searching…' : 'Find my chat ID'}
          </Button>
        </div>

        {discoverResult && (
          <div className="rounded-md border border-border bg-muted/30 p-3">{discoverResult}</div>
        )}

        {(info || error) && (
          <p className={`text-sm ${error ? 'text-destructive' : 'text-emerald-400'}`} role="status">
            {error ?? info}
          </p>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">How to set up — step by step</summary>
          <ol className="mt-2 list-decimal pl-5 space-y-1 text-muted-foreground">
            <li>
              Telegram → <strong>@BotFather</strong> → <code className="rounded bg-muted px-1">/newbot</code>, follow
              the prompts.
            </li>
            <li>
              Paste the token in <strong>Bot token</strong>, then click <strong>Save all</strong>.
            </li>
            <li>
              Open the bot in Telegram and send <code className="rounded bg-muted px-1">/start</code> (or any
              message).
            </li>
            <li>
              Click <strong>Find my chat ID</strong> here. Pick your chat — the ID fills in automatically.
            </li>
            <li>
              Tick <strong>Send Telegram notifications</strong> and click <strong>Save all</strong> again.
            </li>
            <li>
              <strong>Send test message</strong> — you should see it within a second.
            </li>
          </ol>
        </details>
      </CardContent>
    </Card>
  );
}
