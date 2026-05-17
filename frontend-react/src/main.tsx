import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import './index.css';

// MinerWatch React entry point.
//
// Why these wrappers in this exact order?
//   - StrictMode renders components twice in dev to surface accidental
//     side-effects. Worth keeping in even though TanStack Query handles
//     most of those concerns for us.
//   - QueryClientProvider owns the in-memory cache for all /api/* calls.
//     Default options: live data is considered fresh for 2 seconds (so
//     two components mounting at the same time share one fetch), and
//     failures retry once with a tiny backoff. Per-query overrides
//     happen in the hooks under src/api/hooks.ts.
//   - BrowserRouter uses HTML5 history. Basename is "/" because the
//     React app is now the canonical UI (the legacy vanilla frontend
//     was retired in P1 session 5).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// One-shot self-healing: if a previous version of MinerWatch installed
// a service worker that intercepted page loads (or registered HTTP
// caches), iOS Safari / Chrome iOS keep it around indefinitely. The
// current `/sw.js` only handles Web Push and has no fetch handler, so
// stale workers can only do harm. We clear them here on every boot,
// before React mounts, so the next reload starts from a known-good
// state. The cost on a clean browser is one no-op iteration.
function purgeStaleServiceWorkers(): void {
  if (typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  // Fire and forget — we never want to block the React tree on this.
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      for (const reg of regs) {
        const swUrl = reg.active?.scriptURL ?? '';
        // Only purge SWs that are not the current /sw.js. The push
        // settings page will re-register the live one on demand. If a
        // user has never opened Settings, the iPad just has no SW —
        // which is the desired state.
        if (!swUrl.endsWith('/sw.js')) {
          reg.unregister().catch(() => undefined);
        }
      }
    })
    .catch(() => undefined);

  if ('caches' in window) {
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .catch(() => undefined);
  }
}

purgeStaleServiceWorkers();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
