import { Link } from 'react-router-dom';
import { PartyPopper } from 'lucide-react';

import { fmtDifficulty, fmtRelative } from '@/lib/format';
import { useBlockFinds } from '@/api/hooks';

/**
 * Permanent trophy card for solo-mined blocks. Statistically rare for
 * home gear (years between events on a 1-TH/s fleet) so the card is
 * tuned for that kind of "once in a lifetime" celebration: gold glow,
 * never collapsed.
 *
 * Hidden when the block_finds table is empty — most home installs will
 * never see this, and that's the intended outcome.
 */
export function BlockFindsCard() {
  const { data } = useBlockFinds();
  const finds = data?.block_finds ?? [];
  if (!finds.length) return null;

  return (
    <div
      className="rounded-lg border border-yellow-500/40 p-4 shadow-[0_0_0_1px_rgba(255,215,0,0.05)_inset]"
      style={{
        background:
          'radial-gradient(120% 80% at 0% 0%, rgba(255,215,0,0.18), transparent 60%), radial-gradient(120% 80% at 100% 100%, rgba(255,140,0,0.10), transparent 60%), hsl(var(--card))',
      }}
    >
      <header className="mb-3 flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-yellow-400">
          <PartyPopper className="h-4 w-4" />
          <span className="text-sm font-bold uppercase tracking-wider">Blocks found</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {finds.length === 1 ? '1 block' : `${finds.length} blocks`} mined by this fleet — kept forever
        </span>
      </header>
      <ul className="space-y-2">
        {finds.map((f) => (
          <li
            key={`${f.miner_id}-${f.ts}`}
            className="flex items-baseline justify-between gap-3 rounded-md border border-yellow-500/20 bg-card/60 px-3 py-2 text-sm"
          >
            <div>
              <Link to={`/miner/${f.miner_id}`} className="font-semibold text-yellow-300 hover:underline">
                {f.miner_name}
              </Link>
              <span className="ml-2 text-muted-foreground">
                share {fmtDifficulty(f.share_difficulty)} vs network {fmtDifficulty(f.network_difficulty)}
              </span>
              {f.block_height !== null && (
                <span className="ml-2 text-muted-foreground">· block #{f.block_height}</span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{fmtRelative(f.ts)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
