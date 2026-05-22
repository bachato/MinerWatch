import { useState } from 'react';
import { Flame, Snowflake, Loader2, Trophy, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import {
  useTunerStatus,
  useTunerResults,
  useStartTuner,
  useCancelTuner,
} from '@/api/hooks';
import type { MinerDetailResponse, TunerPoint, TunerProfile } from '@/lib/types';

interface Props {
  data: MinerDetailResponse;
}

/**
 * Tuning tab — the efficiency/performance tuner.
 *
 * Sweeps frequency/voltage to find the best pair for a chosen profile
 * (Performance / Eco) under a target temperature, delegating the cooling
 * to MinerWatch's existing auto-fan PID. Clicking a profile opens a
 * mandatory risk-consent modal before anything is sent to the miner.
 *
 * The whole tab self-hides behind the backend feature flag
 * (status.enabled) and the family check (status.supported).
 */
export function TuningPanel({ data }: Props) {
  const minerId = data.miner.id;
  const status = useTunerStatus(minerId);
  const results = useTunerResults(minerId);
  const startTuner = useStartTuner(minerId);
  const cancelTuner = useCancelTuner(minerId);

  // The profile awaiting consent (drives the modal). Null = modal closed.
  const [pendingProfile, setPendingProfile] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = status.data;

  if (status.isLoading || !s) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading tuner…
        </CardContent>
      </Card>
    );
  }

  if (!s.enabled) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          The tuner feature is disabled. Set <code>tuner.enabled</code> to true
          in your config to turn it on.
        </CardContent>
      </Card>
    );
  }

  if (!s.supported) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Tuning is only available for Bitaxe and Nerd* miners.
        </CardContent>
      </Card>
    );
  }

  const running = s.running;
  const live = s.live;
  const session = s.session;
  const profiles = Object.entries(s.profiles ?? {});

  function openConsent(key: string) {
    setError(null);
    setAccepted(false);
    setPendingProfile(key);
  }

  async function confirmStart() {
    if (!pendingProfile) return;
    setError(null);
    try {
      await startTuner.mutateAsync({ profile: pendingProfile, consent: true });
      setPendingProfile(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function onCancel() {
    setError(null);
    try {
      await cancelTuner.mutateAsync();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  const points = results.data?.points ?? [];
  const resultSession = results.data?.session ?? session;

  return (
    <div className="space-y-4">
      {/* ---- Profile pickers ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auto-tune a profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Each profile sweeps frequency and core voltage to find the best
            sustainable pair at its target temperature. The auto-fan PID holds
            the chip near the target while the sweep runs.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {profiles.map(([key, profile]) => (
              <ProfileCard
                key={key}
                profileKey={key}
                profile={profile}
                disabled={running}
                onPick={() => openConsent(key)}
              />
            ))}
          </div>
          {error && !pendingProfile && (
            <p className="text-sm text-destructive" role="status">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---- Running progress ---- */}
      {running && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Loader2 className="h-4 w-4 animate-spin" /> Tuning in progress
            </CardTitle>
            <Button
              variant="subtle"
              onClick={onCancel}
              disabled={cancelTuner.isPending}
            >
              <X className="h-4 w-4" /> Stop
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <ProgressBar value={live?.progress ?? session?.progress ?? 0} />
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span>
                Phase:{' '}
                <span className="font-medium text-foreground">
                  {live?.phase ?? 'starting'}
                </span>
              </span>
              {live?.current?.frequency_mhz != null && (
                <span>
                  Testing:{' '}
                  <span className="font-medium text-foreground tabular-nums">
                    {live.current.frequency_mhz} MHz
                    {live.current.voltage_mv != null
                      ? ` · ${live.current.voltage_mv} mV`
                      : ''}
                  </span>
                </span>
              )}
              {typeof live?.points_done === 'number' && (
                <span>
                  Points tested:{' '}
                  <span className="font-medium text-foreground tabular-nums">
                    {live.points_done}
                  </span>
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Keep an eye on your miner. You can stop the run at any time — the
              tuner will roll the device back to its previous settings.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ---- Last session results ---- */}
      {resultSession && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              Last run · {labelForProfile(resultSession.profile, s.profiles)}
            </CardTitle>
            <SessionStatusBadge status={resultSession.status} />
          </CardHeader>
          <CardContent className="space-y-4">
            {resultSession.status === 'completed' &&
              resultSession.best_frequency_mhz != null && (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
                  <Trophy className="h-4 w-4 text-emerald-400" />
                  <span>
                    Applied:{' '}
                    <span className="font-semibold tabular-nums">
                      {resultSession.best_frequency_mhz} MHz ·{' '}
                      {resultSession.best_voltage_mv} mV
                    </span>
                  </span>
                </div>
              )}
            {resultSession.message && (
              <p className="text-xs text-muted-foreground">
                {resultSession.message}
              </p>
            )}
            {points.length > 0 ? (
              <PointsTable points={points} session={resultSession} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No measured points yet.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ---- Risk-consent modal ("Here be dragons") ---- */}
      <Dialog
        open={pendingProfile !== null}
        onOpenChange={(open) => {
          if (!open) setPendingProfile(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              🐉 Here be dragons
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              This profile pushes your hardware toward its limits to find the
              fastest frequency/voltage combo it can sustain at your target
              temperature.
            </p>
            <p>
              You run it entirely at your own risk. Stay near your miner while
              the tuner is running and keep an eye on it — temperature, noise,
              smell. If anything looks off, cut the power immediately.
            </p>
            <p>
              Legend says overclocking a Bitaxe once meant summoning a dragon.
              We&apos;ve automated the incantation — but the dragon is still
              real, and it does NOT like being left unattended. 🐉
            </p>
            <label className="flex items-start gap-2 rounded-md border border-border bg-background/50 p-3 text-foreground">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>I take the risk by running this function</span>
            </label>
            {error && pendingProfile && (
              <p className="text-destructive" role="status">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="subtle" onClick={() => setPendingProfile(null)}>
              Maybe later
            </Button>
            <Button
              variant="destructive"
              disabled={!accepted || startTuner.isPending}
              onClick={confirmStart}
            >
              {startTuner.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Summon the dragon — at my own risk
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProfileCard({
  profileKey,
  profile,
  disabled,
  onPick,
}: {
  profileKey: string;
  profile: TunerProfile;
  disabled: boolean;
  onPick: () => void;
}) {
  const isEco = profileKey === 'eco';
  const Icon = isEco ? Snowflake : Flame;
  const tone = isEco ? 'text-sky-400' : 'text-orange-400';
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className="flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-4 text-left transition-colors hover:border-primary/60 hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-5 w-5 ${tone}`} />
        <span className="font-semibold">
          {profile.label ?? profileKey}
        </span>
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        Target {profile.target_c}°C · fan up to {profile.fan_cap_pct}%
      </div>
    </button>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function SessionStatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: 'success' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
    completed: { tone: 'success', label: 'Completed' },
    running: { tone: 'secondary', label: 'Running' },
    cancelled: { tone: 'outline', label: 'Cancelled' },
    error: { tone: 'destructive', label: 'Error' },
  };
  const v = map[status] ?? { tone: 'outline' as const, label: status };
  return <Badge variant={v.tone}>{v.label}</Badge>;
}

function PointsTable({
  points,
  session,
}: {
  points: TunerPoint[];
  session: { best_frequency_mhz: number | null; best_voltage_mv: number | null };
}) {
  const num = (v: number | null, digits = 0) =>
    v == null ? '—' : v.toFixed(digits);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Freq</th>
            <th className="py-2 pr-3 font-medium">Volt</th>
            <th className="py-2 pr-3 font-medium">Hashrate</th>
            <th className="py-2 pr-3 font-medium">Chip</th>
            <th className="py-2 pr-3 font-medium">J/TH</th>
            <th className="py-2 pr-3 font-medium">Fan</th>
            <th className="py-2 pr-3 font-medium">HW err %</th>
            <th className="py-2 pr-3 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => {
            const isWinner =
              session.best_frequency_mhz != null &&
              p.frequency_mhz === session.best_frequency_mhz &&
              p.voltage_mv === session.best_voltage_mv;
            const outcomeTone =
              p.outcome === 'valid'
                ? 'text-emerald-400'
                : p.outcome === 'unsafe'
                  ? 'text-destructive'
                  : 'text-muted-foreground';
            return (
              <tr
                key={p.id}
                className={`border-b border-border/50 tabular-nums ${
                  isWinner ? 'bg-emerald-500/10' : ''
                }`}
              >
                <td className="py-1.5 pr-3">
                  {isWinner && (
                    <Trophy className="mr-1 inline h-3 w-3 text-emerald-400" />
                  )}
                  {num(p.frequency_mhz)} MHz
                </td>
                <td className="py-1.5 pr-3">{num(p.voltage_mv)} mV</td>
                <td className="py-1.5 pr-3">{num(p.hashrate_ths, 2)} TH/s</td>
                <td className="py-1.5 pr-3">{num(p.temp_chip_c, 1)}°C</td>
                <td className="py-1.5 pr-3">{num(p.efficiency_j_th, 1)}</td>
                <td className="py-1.5 pr-3">{num(p.fan_pct)}%</td>
                <td className="py-1.5 pr-3">
                  {p.hw_error_pct != null
                    ? `${p.hw_error_pct.toFixed(2)}%`
                    : p.hw_errors_delta == null
                      ? '—'
                      : `${p.hw_errors_delta} err`}
                </td>
                <td className={`py-1.5 pr-3 capitalize ${outcomeTone}`}>
                  {p.outcome ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function labelForProfile(
  key: string,
  profiles: Record<string, TunerProfile>,
): string {
  return profiles?.[key]?.label ?? key;
}
