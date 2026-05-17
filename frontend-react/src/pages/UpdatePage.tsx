import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, api } from '@/lib/api';
import {
  useForceUpdateCheck,
  useInstallUpdate,
  useUpdateCheck,
  useVersion,
} from '@/api/hooks';
import type { VersionResponse } from '@/lib/types';

// Window during which we'll keep polling /api/version waiting for the
// relaunched process to come back. If we don't hear from it in 90s we
// assume the service-manager failed to restart the process and show
// a recovery hint.
const RESTART_TIMEOUT_MS = 90_000;
const RESTART_POLL_INTERVAL_MS = 2_000;

type InstallPhase =
  | 'idle'
  | 'installing' // POST /api/update/install in flight
  | 'restarting' // got the "restarting" response, now polling /api/version
  | 'success'
  | 'error';

/**
 * "Update" page — shown as a sidebar entry under System.
 *
 * The page does three things:
 *   1. Renders the current and latest versions side-by-side.
 *   2. Surfaces the release notes link (always opens upstream GitHub
 *      in a new tab — we don't try to render Markdown inline).
 *   3. Provides an "Install" button that POSTs /api/update/install
 *      and then polls /api/version until the new version answers,
 *      handling the brief restart gap gracefully.
 */
export function UpdatePage() {
  const { data: versionData, refetch: refetchVersion } = useVersion();
  const { data: check, isLoading: checkLoading, error: checkError } = useUpdateCheck();
  const forceCheck = useForceUpdateCheck();
  const install = useInstallUpdate();

  const [phase, setPhase] = useState<InstallPhase>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const restartTimerRef = useRef<number | null>(null);
  const expectedVersionRef = useRef<string | null>(null);

  // Stop the restart-poll loop when the component unmounts (e.g. the
  // user navigates away mid-install). Don't bail on the install
  // itself — the backend has already exited.
  useEffect(() => {
    return () => {
      if (restartTimerRef.current) {
        window.clearTimeout(restartTimerRef.current);
      }
    };
  }, []);

  async function pollForRestart(start: number, expected: string) {
    if (Date.now() - start > RESTART_TIMEOUT_MS) {
      setPhase('error');
      setErrorMessage(
        "The restart took longer than 90 seconds. Check that the MinerWatch service is running " +
          '(`launchctl list | grep minerwatch` on macOS, `systemctl --user status minerwatch` on Linux). ' +
          'Your previous version is still installed.',
      );
      return;
    }
    try {
      const v = await api<VersionResponse>('/api/version');
      if (v.version === expected) {
        setPhase('success');
        setStatusMessage(`MinerWatch is now running v${v.version}.`);
        // Refresh the cached version everywhere in the app (sidebar
        // footer, etc.) so the new value propagates without a manual
        // reload.
        await refetchVersion();
        return;
      }
      // Service came back up but on the old version — could be a
      // failed start.sh deps install. Keep polling for a bit; the
      // timeout will trip eventually.
      setStatusMessage(`Service back up at v${v.version}, waiting for v${expected}…`);
    } catch {
      // The expected case during restart: the process is down.
      setStatusMessage('Waiting for MinerWatch to come back up…');
    }
    restartTimerRef.current = window.setTimeout(
      () => pollForRestart(start, expected),
      RESTART_POLL_INTERVAL_MS,
    );
  }

  async function handleInstall() {
    setPhase('installing');
    setErrorMessage('');
    setStatusMessage('Downloading and verifying release…');
    try {
      const resp = await install.mutateAsync();
      expectedVersionRef.current = resp.new_version;
      setPhase('restarting');
      setStatusMessage(
        `Installed v${resp.new_version}. Restarting service — this usually takes 10–20 seconds.`,
      );
      pollForRestart(Date.now(), resp.new_version);
    } catch (err) {
      setPhase('error');
      setErrorMessage(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Install failed (unknown error).',
      );
    }
  }

  function handleCheckNow() {
    forceCheck.mutate();
  }

  // The interactive button at the bottom of the "available" card
  // morphs through phases. Keep its label and disabled state derived
  // from one source so we don't get inconsistent states.
  const installing = phase === 'installing' || phase === 'restarting';

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Update</h1>
        <p className="text-sm text-muted-foreground">
          Pull the latest MinerWatch release from GitHub and restart the service.
        </p>
      </header>

      {/* Current version card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Installed version</CardTitle>
              <CardDescription>
                The version currently running on this host.
              </CardDescription>
            </div>
            <Badge variant="outline" className="font-mono text-sm">
              v{versionData?.version ?? '…'}
            </Badge>
          </div>
        </CardHeader>
        {versionData?.system && (
          <CardContent className="grid grid-cols-2 gap-4 text-xs text-muted-foreground sm:grid-cols-4">
            <Field label="OS" value={`${versionData.system.os} ${versionData.system.os_release}`} />
            <Field label="Arch" value={versionData.system.machine} />
            <Field label="Python" value={versionData.system.python} />
            <Field label="Channel" value="stable (Releases)" />
          </CardContent>
        )}
      </Card>

      {/* Check status / available release card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Latest release</CardTitle>
              <CardDescription>
                Source: github.com/imlenti/MinerWatch · checked every 6 hours.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckNow}
              disabled={forceCheck.isPending}
            >
              {forceCheck.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Check now
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {checkLoading && !check ? (
            <Skeleton className="h-20 w-full" />
          ) : checkError ? (
            <p className="text-sm text-muted-foreground">
              Couldn't reach GitHub. Will retry automatically.
            </p>
          ) : check?.error ? (
            <CheckError code={check.error} />
          ) : check?.available ? (
            <AvailableBody
              check={check}
              phase={phase}
              installing={installing}
              statusMessage={statusMessage}
              errorMessage={errorMessage}
              onInstall={handleInstall}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              You're on the latest version
              {check?.latest ? ` (v${check.latest}).` : '.'}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Safety blurb — always visible, so the user knows what the
          install button actually touches. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            What the update touches
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            The new release is downloaded, its SHA-256 is verified against the
            checksum published with the release, then the code files are swapped
            into place. The MinerWatch service then exits and is automatically
            relaunched by the system (launchd on macOS, systemd on Linux).
          </p>
          <p>
            <strong className="text-foreground">Your data is preserved:</strong>{' '}
            <code className="rounded bg-muted/40 px-1">data/</code> (DB, push
            keys, logs), <code className="rounded bg-muted/40 px-1">config.yaml</code>
            , and <code className="rounded bg-muted/40 px-1">.venv/</code> are
            never overwritten. Python dependencies are reinstalled on the next
            boot if <code className="rounded bg-muted/40 px-1">requirements.txt</code>{' '}
            changed.
          </p>
          <p>
            If anything fails before the file swap (download, SHA-256, extract),
            the install aborts and the running version stays untouched.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- small subcomponents ----------

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider">{label}</div>
      <div className="mt-0.5 text-foreground">{value}</div>
    </div>
  );
}

function CheckError({ code }: { code: string }) {
  const message: Record<string, string> = {
    no_releases:
      'No releases have been published on GitHub yet. You\'re running the latest code.',
    rate_limited:
      'GitHub rate-limited the check. Will try again in 6 hours, or click "Check now" later.',
    network_error:
      "Couldn't reach GitHub — check your internet connection.",
  };
  const friendly =
    message[code] ?? `Check failed (${code}). Will retry automatically.`;
  return (
    <div className="flex items-start gap-2 text-sm text-muted-foreground">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <span>{friendly}</span>
    </div>
  );
}

interface AvailableBodyProps {
  check: NonNullable<ReturnType<typeof useUpdateCheck>['data']>;
  phase: InstallPhase;
  installing: boolean;
  statusMessage: string;
  errorMessage: string;
  onInstall: () => void;
}

function AvailableBody({
  check,
  phase,
  installing,
  statusMessage,
  errorMessage,
  onInstall,
}: AvailableBodyProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight">
          v{check.latest}
        </span>
        <span className="text-sm text-muted-foreground">available</span>
        {check.published_at && (
          <span className="text-xs text-muted-foreground">
            · published {new Date(check.published_at).toLocaleDateString()}
          </span>
        )}
      </div>

      {check.release_notes_url && (
        <a
          href={check.release_notes_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          View release notes
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}

      {check.requires_service_reinstall && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This release updates the system service files. After the install,
            re-run <code className="font-mono">scripts/install-service.sh</code>{' '}
            manually so the LaunchAgent/systemd unit picks up the new template.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onInstall} disabled={installing}>
          {installing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {phase === 'installing'
            ? 'Installing…'
            : phase === 'restarting'
              ? 'Restarting…'
              : `Install v${check.latest}`}
        </Button>
        {check.sha256 && (
          <span className="font-mono text-[10px] text-muted-foreground">
            sha256: {check.sha256.slice(0, 12)}…
          </span>
        )}
      </div>

      {(statusMessage || phase === 'success' || errorMessage) && (
        <div
          className={
            phase === 'success'
              ? 'flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300'
              : phase === 'error'
                ? 'flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300'
                : 'flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground'
          }
        >
          {phase === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : phase === 'error' ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          )}
          <span>{errorMessage || statusMessage}</span>
        </div>
      )}
    </div>
  );
}
