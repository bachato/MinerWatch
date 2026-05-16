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
//   - BrowserRouter uses HTML5 history. The basename matches the Vite
//     `base` (/v2/) so links inside the app stay relative to the new
//     prefix during the migration.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/v2">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
