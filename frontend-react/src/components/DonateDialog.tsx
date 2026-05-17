import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Heart } from 'lucide-react';

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
export function DonateDialog({ open, onOpenChange }: DonateDialogProps) {
  const [copied, setCopied] = useState(false);

  // Reset the "Copied!" indicator whenever the dialog is reopened, so
  // a stale "Copied" doesn't linger from a previous open.
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  // Auto-clear the "Copied" label after 2s so the button reverts to its
  // normal affordance.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(BTC_ADDRESS);
      setCopied(true);
    } catch {
      // navigator.clipboard can fail on insecure origins (http on a LAN
      // IP that isn't localhost). Fall back to a textarea trick.
      const ta = document.createElement('textarea');
      ta.value = BTC_ADDRESS;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
      } catch {
        /* give up silently */
      }
      document.body.removeChild(ta);
    }
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
            <code className="block break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
              {BTC_ADDRESS}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Copied
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
