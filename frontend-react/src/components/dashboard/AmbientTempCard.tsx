import { Card } from '@/components/ui/card';
import { useAmbientTemp } from '@/api/hooks';

/**
 * Ambient temperature card — a 1:1 port of the ESP32 panel's bottom row.
 *
 * Same texts ("Temperature: X°C | Min: Y°C | Max: Z°C") and almost the
 * same colour logic as ``common/minerwatch-core.yaml`` in the ESPHome
 * panel — the one exception is the warm stop, retuned to the app's
 * amber-400 so the yellow matches the chip-temp readouts:
 *   - current value: a blue→teal→green→amber→red gradient interpolated
 *     across the 15/20/24/28/32 °C stops (so it can't be a Tailwind class,
 *     hence the inline colour);
 *   - Min always light blue, Max always red, the prefixes stay muted;
 *   - no reading → grey "-".
 *
 * The data is relayed by MinerWatch from the optional MQTT sensor topic,
 * so the card only appears when a value has actually been received
 * (``has_data``) — exactly like the panel hides the row otherwise.
 */

const NODATA_COLOR = '#9AA0A6';
const MIN_COLOR = '#4DA6FF';
const MAX_COLOR = '#E01B24';

// Gradient stops adapted from the panel lambda, with one deliberate
// change: the warm stop (28 °C) is retuned to the app's amber-400
// (#FBBF24) so the "yellow" matches the chip-temp readouts and the
// work-mode buttons. Min (blue) and Max (red) stay as the panel has
// them. Kept as parallel arrays to mirror the firmware source.
const G_T = [15, 20, 24, 28, 32];
const G_R = [59, 45, 51, 251, 224];
const G_G = [130, 212, 209, 191, 27];
const G_B = [246, 191, 122, 36, 36];

/** Interpolated #rrggbb for the current value, matching the panel. */
function gradientColor(tc: number): string {
  let r: number;
  let g: number;
  let b: number;
  if (tc <= G_T[0]) {
    [r, g, b] = [G_R[0], G_G[0], G_B[0]];
  } else if (tc >= G_T[4]) {
    [r, g, b] = [G_R[4], G_G[4], G_B[4]];
  } else {
    let i = 0;
    while (tc > G_T[i + 1]) i++;
    const f = (tc - G_T[i]) / (G_T[i + 1] - G_T[i]);
    r = G_R[i] + f * (G_R[i + 1] - G_R[i]);
    g = G_G[i] + f * (G_G[i + 1] - G_G[i]);
    b = G_B[i] + f * (G_B[i + 1] - G_B[i]);
  }
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Whole-degree "<n>°C" like the panel's %.0f, or "-" when absent. */
function fmtTemp(v: number | null): string {
  return v === null ? '-' : `${Math.round(v)}°C`;
}

export function AmbientTempCard() {
  const { data } = useAmbientTemp();

  // Show only once a reading exists — mirrors the panel hiding the row
  // (and matches the dashboard's "only when data is present" rule).
  if (!data || !data.has_data) return null;

  const curColor = data.current_c === null ? NODATA_COLOR : gradientColor(data.current_c);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-base sm:text-lg">
        <span className="text-muted-foreground">Temperature:</span>
        <span className="font-semibold tabular-nums" style={{ color: curColor }}>
          {fmtTemp(data.current_c)}
        </span>
        <span className="text-muted-foreground">| Min:</span>
        <span className="font-semibold tabular-nums" style={{ color: MIN_COLOR }}>
          {fmtTemp(data.min_c)}
        </span>
        <span className="text-muted-foreground">| Max:</span>
        <span className="font-semibold tabular-nums" style={{ color: MAX_COLOR }}>
          {fmtTemp(data.max_c)}
        </span>
      </div>
    </Card>
  );
}
