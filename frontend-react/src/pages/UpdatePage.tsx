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
// relaunched process to come back. The polling is now a "nice to
// have" (it lets us show an earlier success message when /api/version
// confirms the new build), but it is NOT what triggers the reload.
const RESTART_POLL_INTERVAL_MS = 2_000;
const RESTART_POLL_TIMEOUT_MS = 60_000;

// The reload is *guaranteed* by an unconditional setTimeout the
// moment ``handleInstall`` returns from ``install.mutateAsync()``.
// Two reasons it can't depend on the polling loop:
//
//   1. The polling depends on /api/version reaching us during the
//      restart window, which can fail in subtle ways: a connection
//      reset right after ``os._exit(1)`` resolves to a fetch error
//      we can't always recover cleanly, and one stray exception in
//      the chain leaves the user stuck on a stale page with the
//      Install button still showing.
//   2. The reload is *required* anyway — after the in-place file
//      swap, the running React app references Vite-hashed JS/CSS
//      chunks (index-XXXX.js, charts-YYYY.js, ...) that no longer
//      exist on disk. So whatever happens to the polling loop, we
//      must reload.
//
// 25s is a generous window: typical restarts complete in 10–15s,
// the first boot after a release that bumped requirements.txt can
// take ~20s while ``start.sh`` does ``pip install``. We bias toward
// "user waits an extra few seconds" over "page reloads while the
// backend is still down".
const HARD_RELOAD_DELAY_MS = 25_000;
// When the polling loop *does* confirm the new version before the
// hard deadline, we accelerate the reload to give the user a snappier
// experience. 1s is enough to flash the success banner.
const POLLING_SUCCESS_RELOAD_MS = 1_500;

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
  // Live countdown shown in the "restarting" status message. Ticks
  // down once per second from HARD_RELOAD_DELAY_MS down to 0, then
  // the hard-reload timer fires the actual reload. ``null`` outside
  // of an install: there's no countdown to show.
  const [reloadCountdown, setReloadCountdown] = useState<number | null>(null);
  // The version we just installed — used to build the live message
  // alongside the countdown state. Kept separately from
  // statusMessage so the message body can interpolate the current
  // tick of the timer without re-`setStatusMessage` every second.
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  // Separate refs for the timers so the polling loop can't
  // accidentally clobber the hard-reload deadline (the original
  // single-ref design was clobbering itself on each poll tick,
  // which is part of why the reload never fired).
  const hardReloadTimerRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);

  // Stop both loops when the component unmounts (e.g. the user
  // navigates away mid-install). The hard-reload timer keeps running
  // even on unmount in spirit — it doesn't need React state, it'll
  // just reload the whole window — so we only clear it if we want
  // to abort it (e.g. on error).
  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
      if (countdownIntervalRef.current !== null) {
        window.clearInterval(countdownIntervalRef.current);
      }
      // Note: we deliberately do NOT clear hardReloadTimerRef on
      // unmount. If the user navigates to another route while an
      // install is in flight, we still want the page to reload at
      // the deadline so all components re-render with the new
      // bundle.
    };
  }, []);

  async function pollForRestart(start: number, expected: string) {
    if (Date.now() - start > RESTART_POLL_TIMEOUT_MS) {
      // We've stopped trying to confirm via /api/version. The
      // hard-reload timer is still armed and will fire shortly,
      // so we just stop polling silently — no error to show.
      return;
    }
    try {
      const v = await api<VersionResponse>('/api/version');
      if (v.version === expected) {
        setPhase('success');
        setStatusMessage(
          `MinerWatch is now running v${v.version}. Reloading…`,
        );
        // The big countdown is over — kill the tick so the
        // "in Ns…" text doesn't keep flashing under the success
        // banner.
        if (countdownIntervalRef.current !== null) {
          window.clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
        setReloadCountdown(null);
        // Polling confirmed the new build — accelerate the reload.
        // Cancel the long fallback timer and schedule a short one.
        if (hardReloadTimerRef.current !== null) {
          window.clearTimeout(hardReloadTimerRef.current);
        }
        hardReloadTimerRef.current = window.setTimeout(() => {
          window.location.reload();
        }, POLLING_SUCCESS_RELOAD_MS);
        // Best-effort refresh of the cached version in React Query;
        // wrapped in try/catch so a stray error here can't block
        // the reload (this was a latent bug in the old code).
        try {
          await refetchVersion();
        } catch {
          /* ignore: the reload below will refresh everything anyway */
        }
        return;
      }
      setStatusMessage(`Service back up at v${v.version}, waiting for v${expected}…`);
    } catch {
      // The expected case during restart: the backend is down.
      // Don't overwrite the countdown message — the live counter is
      // the better feedback. Only set a status message if the
      // countdown isn't running.
      if (countdownIntervalRef.current === null) {
        setStatusMessage('Waiting for MinerWatch to come back up…');
      }
    }
    pollTimerRef.current = window.setTimeout(
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
      setPhase('restarting');
      setInstalledVersion(resp.new_version);
      // statusMessage is left empty during 'restarting': the message
      // body is now built dynamically from installedVersion +
      // reloadCountdown so the seconds tick visibly. See the
      // AvailableBody render branch.
      setStatusMessage('');
      // Start the live countdown. Initial value mirrors the hard
      // reload deadline; ticks down once per second; lands on 0 right
      // before the reload fires.
      const totalSeconds = Math.round(HARD_RELOAD_DELAY_MS / 1000);
      setReloadCountdown(totalSeconds);
      if (countdownIntervalRef.current !== null) {
        window.clearInterval(countdownIntervalRef.current);
      }
      countdownIntervalRef.current = window.setInterval(() => {
        setReloadCountdown((prev) => {
          if (prev === null) return null;
          if (prev <= 1) {
            // Reached zero — let the hard-reload timer fire. Don't
            // try to clear the interval here (we're inside the
            // updater); the unmount cleanup or the success branch
            // will handle it.
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      // Hard guarantee: schedule the reload unconditionally the
      // moment we have the install response. This timer fires even
      // if the polling loop below never finds /api/version (network
      // blip, slow boot, anything). The polling loop just gets to
      // *accelerate* the reload if it confirms the new version
      // earlier — see the success branch in pollForRestart.
      if (hardReloadTimerRef.current !== null) {
        window.clearTimeout(hardReloadTimerRef.current);
      }
      hardReloadTimerRef.current = window.setTimeout(() => {
        window.location.reload();
      }, HARD_RELOAD_DELAY_MS);
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
      // The install never started — abort the reload + countdown so
      // the user can see the error message.
      if (hardReloadTimerRef.current !== null) {
        window.clearTimeout(hardReloadTimerRef.current);
        hardReloadTimerRef.current = null;
      }
      if (countdownIntervalRef.current !== null) {
        window.clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      setReloadCountdown(null);
      setInstalledVersion(null);
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
              installedVersion={installedVersion}
              reloadCountdown={reloadCountdown}
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
  installedVersion: string | null;
  reloadCountdown: number | null;
  onInstall: () => void;
}

function AvailableBody({
  check,
  phase,
  installing,
  statusMessage,
  errorMessage,
  installedVersion,
  reloadCountdown,
  onInstall,
}: AvailableBodyProps) {
  // Build the body of the status banner, with the special-cased live
  // countdown during the 'restarting' phase. The countdown ticks once
  // per second (driven by the setInterval armed in handleInstall),
  // and this expression re-evaluates on every state update so the
  // displayed number is always fresh.
  const displayMessage = (() => {
    if (errorMessage) return errorMessage;
    if (phase === 'restarting' && installedVersion !== null && reloadCountdown !== null) {
      const noun = reloadCountdown === 1 ? 'second' : 'seconds';
      return `Installed v${installedVersion}. MinerWatch is restarting — page reloads in ${reloadCountdown} ${noun}…`;
    }
    return statusMessage;
  })();
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

      {(statusMessage || phase === 'success' || phase === 'restarting' || errorMessage) && (
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
          <span>{displayMessage}</span>
        </div>
      )}
    </div>
  );
}
