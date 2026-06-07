import { Heart } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DonateBtcCard } from '@/components/DonateBtcCard';

// NOTE: Currently unmounted — the sidebar "Donate" entry now navigates
// to the full /donations page (DonationsPage) instead of opening this
// modal. Retained intentionally so the modal can be reinstated later
// without rebuilding it. The BTC card body lives in DonateBtcCard, which
// both this dialog and the page share.

interface DonateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Support MinerWatch" modal — BTC address + QR. */
export function DonateDialog({ open, onOpenChange }: DonateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Heart className="h-5 w-5 text-red-500" />
            Support MinerWatch
          </DialogTitle>
          <DialogDescription>
            If MinerWatch is useful to your home rig, donations are welcome — Bitcoin on-chain or Lightning.
          </DialogDescription>
        </DialogHeader>

        <DonateBtcCard />
      </DialogContent>
    </Dialog>
  );
}
