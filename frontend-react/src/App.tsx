import { Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/AppShell';
import { DashboardPage } from '@/pages/DashboardPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { LiveSharesPage } from '@/pages/LiveSharesPage';
import { MinerPage } from '@/pages/MinerPage';
import { PoolsPage } from '@/pages/PoolsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { SystemPage } from '@/pages/SystemPage';
import { UpdatePage } from '@/pages/UpdatePage';
import { LoginPage } from '@/pages/LoginPage';

// Top-level routing.
//
// Two route trees:
//   - /login renders its own layout (no sidebar)
//   - everything else renders inside <AppShell />, which provides the
//     sidebar and the main content slot
//
// Route guards (redirect to /login when auth.enabled and not signed in)
// live in AppShell via a wrapper we'll add when we wire the real
// authenticated-fetch flow in session 2. For session 1 the shell is
// always visible and the API layer raises ApiError on 401, which
// individual pages will surface inline.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/live" element={<LiveSharesPage />} />
        <Route path="/pools" element={<PoolsPage />} />
        <Route path="/miner/:id" element={<MinerPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="/update" element={<UpdatePage />} />
        <Route path="*" element={<DashboardPage />} />
      </Route>
    </Routes>
  );
}
