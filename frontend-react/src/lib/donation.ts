import type { MinerFamily } from '@/lib/types';

// Single, hard-coded BTC donation address — the project-wide constant
// (every MinerWatch user sees the same address). Kept here so both the
// donate-BTC card and the Donations page share one source of truth.
// The backend owns the *authoritative* copy (backend/donations.py); a
// donation can only ever pay this wallet because the server builds the
// worker name itself. If you fork the project and want donations to go
// to your wallet, change it in BOTH places.
export const BTC_DONATION_ADDRESS =
  'bc1qexhamvrpclpr2skyyw3u8edm8kznnvt6zjudxu';

// Families whose driver can repoint its pool (backend can_set_pool=True).
// Mirrors the backend so the donate-hashrate UI can disable miners it
// can't switch without an extra per-miner capability fetch.
export const DONATION_SUPPORTED_FAMILIES: MinerFamily[] = [
  'bitaxe',
  'nerdoctaxe',
];

export function familySupportsDonation(family: MinerFamily | null | undefined): boolean {
  return !!family && DONATION_SUPPORTED_FAMILIES.includes(family);
}

/** "2h 14m" / "47m" / "<1m" — compact countdown for the active table. */
export function fmtRemaining(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds <= 0) return 'ending…';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}
