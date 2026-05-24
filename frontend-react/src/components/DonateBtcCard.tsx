import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AlertTriangle, Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { BTC_DONATION_ADDRESS } from '@/lib/donation';

// The BTC donate block: QR code + address + copy-to-clipboard, rendered
// client-side (the address never leaves the browser, no third-party API).
// Extracted from the old DonateDialog so both the Donations page and the
// (retained) dialog can reuse the exact same copy logic — which is
// finicky because MinerWatch is usually served over plain HTTP on a LAN.

type CopyStatus = 'idle' | 'copied' | 'selected' | 'failed';

interface DonateBtcCardProps {
  /** Show the "donations are voluntary…" footnote (default true). */
  showFootnote?: boolean;
  qrSize?: number;
}

export function DonateBtcCard({ showFootnote = true, qrSize = 180 }: DonateBtcCardProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  // Selection-fallback target: the on-screen <code> node holding the
  // address. Used when neither the Clipboard API nor execCommand works.
  const addressNodeRef = useRef<HTMLElement | null>(null);

  // Auto-clear feedback after 3s. 3s (not 2s) because the "selected —
  // press Cmd+C" hint needs slightly longer to read.
  useEffect(() => {
    if (copyStatus === 'idle') return;
    const t = setTimeout(() => setCopyStatus('idle'), 3000);
    return () => clearTimeout(t);
  }, [copyStatus]);

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
        await navigator.clipboard.writeText(BTC_DONATION_ADDRESS);
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
      {/* QR must be white-on-black so wallet scanners get the contrast,
          even in dark mode. */}
      <div className="rounded-md bg-white p-3">
        <QRCodeSVG
          value={`bitcoin:${BTC_DONATION_ADDRESS}`}
          size={qrSize}
          level="M"
          marginSize={0}
        />
      </div>

      <div className="w-full space-y-2">
        <label className="text-xs uppercase tracking-wider text-muted-foreground">
          Bitcoin address
        </label>
        <code
          ref={addressNodeRef}
          className="block break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs"
        >
          {BTC_DONATION_ADDRESS}
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
