import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AlertTriangle, Check, Copy, Heart } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// Single, hard-coded BTC donation address. Lives here (not in config)
// because it's a project-wide constant, not a per-install setting —
// every MinerWatch user sees the same address. If you fork the project
// and want donations to go to *your* wallet, change this string.
const BTC_ADDRESS = 'bc1qexhamvrpclpr2skyyw3u8edm8kznnvt6zjudxu';

interface DonateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Support MinerWatch" modal.
 *
 * Triggered from the sidebar "Donate" entry. Shows the project's BTC
 * address with a copy-to-clipboard button and a QR code so the user can
 * pay from a wallet on a different device (phone scans QR on laptop
 * screen). Renders the QR client-side via qrcode.react — the address
 * never leaves the browser, no third-party API.
 */
type CopyStatus = 'idle' | 'copied' | 'selected' | 'failed';

export function DonateDialog({ open, onOpenChange }: DonateDialogProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  // Ref to the <code> element that holds the address. Used as a fallback
  // selection target when neither navigator.clipboard nor execCommand
  // can put the bytes into the clipboard — at least we highlight the
  // address so the user can do Cmd/Ctrl+C themselves.
  const addressNodeRef = useRef<HTMLElement | null>(null);

  // Reset the feedback whenever the dialog is reopened so a stale
  // "Copied!" / "Press Cmd+C" doesn't linger from a previous open.
  useEffect(() => {
    if (!open) setCopyStatus('idle');
  }, [open]);

  // Auto-clear the feedback after 3s so the button reverts to its
  // normal affordance. We pick 3s instead of 2s because the "selected
  // — press Cmd+C" hint needs slightly more time to read than just
  // "Copied".
  useEffect(() => {
    if (copyStatus === 'idle') return;
    const t = setTimeout(() => setCopyStatus('idle'), 3000);
    return () => clearTimeout(t);
  }, [copyStatus]);

  // ``copyStatus`` distinguishes three end-states so the UI can tell
  // the truth: "copied" (clipboard genuinely got the value), "selected"
  // (we couldn't write to the clipboard but the address is highlighted
  // in the page, just press Cmd/Ctrl+C), and "failed" (we couldn't
  // even select it, the user has to copy by hand).
  async function handleCopy() {
    // Strategy 1: modern Clipboard API. Only works in secure contexts —
    // that's https:// or http://localhost. On a LAN like
    // http://192.168.1.17:8000 the browser silently refuses, which is
    // exactly the bug we hit before: the writeText() Promise rejects,
    // we caught the rejection, fell back to execCommand, and the
    // ``try { document.execCommand('copy'); setCopied(true); }`` block
    // happily reported "Copied!" even when execCommand returned false.
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard?.writeText &&
      window.isSecureContext
    ) {
      try {
        await navigator.clipboard.writeText(BTC_ADDRESS);
        setCopyStatus('copied');
        return;
      } catch {
        // fall through — even on isSecureContext, some browsers can
        // refuse (e.g. permission policy)
      }
    }

    // Strategy 2: legacy execCommand('copy'). Required for HTTP-on-LAN.
    // Must keep the textarea visible (not display:none, not
    // visibility:hidden, not opacity:0) on iOS Safari and on some
    // Chromium builds — those silently swallow execCommand if the
    // selection isn't a real on-screen element. We make it 1px and
    // off-screen but technically visible.
    const ta = document.createElement('textarea');
    ta.value = BTC_ADDRESS;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.outline = 'none';
    ta.style.boxShadow = 'none';
    ta.style.background = 'transparent';
    document.body.appendChild(ta);

    // Save and restore the current selection so we don't trash whatever
    // the user had highlighted before clicking Copy.
    const previousSelection =
      document.getSelection()?.rangeCount ? document.getSelection()?.getRangeAt(0) : null;

    ta.focus();
    ta.select();
    ta.setSelectionRange(0, BTC_ADDRESS.length);

    let succeeded = false;
    try {
      // execCommand returns a boolean — false means the browser
      // refused. We MUST check the return value; the previous code
      // ignored it.
      succeeded = document.execCommand('copy');
    } catch {
      succeeded = false;
    }

    document.body.removeChild(ta);

    // Restore the user's prior selection.
    if (previousSelection) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(previousSelection);
    }

    if (succeeded) {
      setCopyStatus('copied');
      return;
    }

    // Strategy 3 (last resort): we couldn't get the bytes into the
    // clipboard. Select the address node in the dialog so the user
    // just presses Cmd/Ctrl+C themselves.
    const node = addressNodeRef.current;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      setCopyStatus('selected');
      return;
    }

    setCopyStatus('failed');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Heart className="h-5 w-5 text-red-500" />
            Support MinerWatch
          </DialogTitle>
          <DialogDescription>
            If MinerWatch is useful to your home rig, donations are welcome — BTC only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {/* QR code generated client-side. White background is required
              so wallet scanners can pick up the contrast — even in dark
              mode the QR module must be white-on-black, not theme-on-theme. */}
          <div className="rounded-md bg-white p-3">
            <QRCodeSVG
              value={`bitcoin:${BTC_ADDRESS}`}
              size={180}
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
              {BTC_ADDRESS}
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

          <p className="text-center text-[11px] text-muted-foreground">
            Donations are voluntary and don't unlock any feature — MinerWatch is
            and stays AGPL-3.0, free, local-first.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
