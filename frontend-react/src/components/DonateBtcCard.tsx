import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AlertTriangle, Bitcoin, Check, Copy, Zap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { BTC_DONATION_ADDRESS, LN_DONATION_ADDRESS } from '@/lib/donation';
import { cn } from '@/lib/utils';

// The donate block: a segmented On-chain / Lightning toggle on top, then a
// QR code + address + copy-to-clipboard for the selected method, rendered
// client-side (the address never leaves the browser, no third-party API).
// Extracted from the old DonateDialog so both the Donations page and the
// (retained) dialog can reuse the exact same copy logic — which is
// finicky because MinerWatch is usually served over plain HTTP on a LAN.

type CopyStatus = 'idle' | 'copied' | 'selected' | 'failed';
type DonateTab = 'onchain' | 'lightning';

interface DonateBtcCardProps {
  /** Show the "donations are voluntary…" footnote (default true). */
  showFootnote?: boolean;
  qrSize?: number;
}

export function DonateBtcCard({ showFootnote = true, qrSize = 180 }: DonateBtcCardProps) {
  const [tab, setTab] = useState<DonateTab>('onchain');
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  // Selection-fallback target: the on-screen <code> node holding the
  // address. Used when neither the Clipboard API nor execCommand works.
  const addressNodeRef = useRef<HTMLElement | null>(null);

  const isLightning = tab === 'lightning';
  const address = isLightning ? LN_DONATION_ADDRESS : BTC_DONATION_ADDRESS;
  // QR payload: BIP-21 bitcoin: URI on-chain; lightning: URI for the
  // Lightning Address (LUD-16) — both schemes most wallets recognise.
  const qrValue = isLightning ? `lightning:${address}` : `bitcoin:${address}`;

  // Auto-clear feedback after 3s. 3s (not 2s) because the "selected —
  // press Cmd+C" hint needs slightly longer to read.
  useEffect(() => {
    if (copyStatus === 'idle') return;
    const t = setTimeout(() => setCopyStatus('idle'), 3000);
    return () => clearTimeout(t);
  }, [copyStatus]);

  function selectTab(next: DonateTab) {
    if (next === tab) return;
    setTab(next);
    // Drop any "Copied"/"Selected" feedback so it doesn't linger on the
    // other method's address after switching.
    setCopyStatus('idle');
  }

  async function handleCopy() {
    // Strategy 1: modern Clipboard API. Only works in secure contexts
    // (https / localhost). On a LAN like http://192.168.x.y the browser
    // refuses, so we fall through.
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard?.writeText &&
      window.isSecureContext
    ) {
      try {
        await navigator.clipboard.writeText(address);
        setCopyStatus('copied');
        return;
      } catch {
        // even on secure contexts some browsers can refuse — fall through
      }
    }

    // Strategy 2: legacy execCommand('copy') over the on-screen node. We
    // select the <code> already in the DOM (not a throwaway textarea) so
    // any focus trap around us doesn't steal the selection.
    const node = addressNodeRef.current;
    if (node) {
      const sel = document.getSelection();
      const previousRange =
        sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

      const range = document.createRange();
      range.selectNodeContents(node);
      sel?.removeAllRanges();
      sel?.addRange(range);

      let succeeded = false;
      try {
        succeeded = document.execCommand('copy');
      } catch {
        succeeded = false;
      }

      if (succeeded) {
        sel?.removeAllRanges();
        if (previousRange) sel?.addRange(previousRange);
        setCopyStatus('copied');
        return;
      }

      // Strategy 3: leave it highlighted so the user presses Cmd/Ctrl+C.
      setCopyStatus('selected');
      return;
    }

    setCopyStatus('failed');
  }

  return (
    <div className="flex flex-col items-center gap-4 py-2">
      {/* On-chain / Lightning toggle. Mirrors the shadcn Tabs styling so it
          looks native, but stays inline since both tabs share one QR/code
          area that just swaps its value. */}
      <div className="flex w-full items-center gap-1 rounded-lg border border-border bg-card p-1 text-muted-foreground">
        <button
          type="button"
          onClick={() => selectTab('onchain')}
          aria-pressed={!isLightning}
          className={cn(
            'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            !isLightning && 'bg-background text-foreground shadow-sm',
          )}
        >
          <Bitcoin className="h-3.5 w-3.5" />
          On-chain
        </button>
        <button
          type="button"
          onClick={() => selectTab('lightning')}
          aria-pressed={isLightning}
          className={cn(
            'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            isLightning && 'bg-background text-foreground shadow-sm',
          )}
        >
          <Zap className="h-3.5 w-3.5" />
          Lightning
        </button>
      </div>

      {/* QR must be white-on-black so wallet scanners get the contrast,
          even in dark mode. */}
      <div className="rounded-md bg-white p-3">
        <QRCodeSVG value={qrValue} size={qrSize} level="M" marginSize={0} />
      </div>

      <div className="w-full space-y-2">
        <label className="text-xs uppercase tracking-wider text-muted-foreground">
          {isLightning ? 'Lightning address' : 'Bitcoin address'}
        </label>
        <code
          ref={addressNodeRef}
          className="block break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
        >
          {address}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={handleCopy}
        >
          {copyStatus === 'copied' ? (
            <>
              <Check className="h-3.5 w-3.5" />
              Copied
            </>
          ) : copyStatus === 'selected' ? (
            <>
              <Check className="h-3.5 w-3.5" />
              Selected — press Cmd/Ctrl+C
            </>
          ) : copyStatus === 'failed' ? (
            <>
              <AlertTriangle className="h-3.5 w-3.5" />
              Copy failed — select manually
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy address
            </>
          )}
        </Button>
      </div>

      {showFootnote && (
        <p className="text-center text-[11px] text-muted-foreground">
          Donations are voluntary and don't unlock any feature — MinerWatch is
          and stays AGPL-3.0, free, local-first.
        </p>
      )}
    </div>
  );
}
