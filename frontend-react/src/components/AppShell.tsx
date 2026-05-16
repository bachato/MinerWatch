import { NavLink, Outlet } from 'react-router-dom';
import { Activity, BarChart3, Cpu, Server, Settings as SettingsIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

// MinerWatch's persistent shell: sidebar on the left with the four main
// nav entries, plus a slot for the page content on the right. Every
// route inside AppShell renders into <Outlet />, so individual pages
// don't have to redeclare the sidebar.
//
// The shell deliberately leaves vertical space generous and the sidebar
// width compact (240px). MinerSentinel uses ~260px; we go slightly
// tighter so the data area gets more pixels — on a 1280px window every
// 20px on the left side is one extra column of miner cards.

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    label: 'Dashboard',
    icon: Activity,
    description: 'Fleet overview',
    end: true,
  },
  {
    to: '/analytics',
    label: 'Analytics',
    icon: BarChart3,
    description: 'Predictions & records',
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    description: 'Configuration',
  },
  {
    to: '/system',
    label: 'System',
    icon: Server,
    description: 'Host metrics',
  },
];

export function AppShell() {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden md:flex w-60 flex-col border-r border-border bg-card/50 px-4 py-6">
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
            <Cpu className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold leading-tight">MinerWatch</div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Mining monitor
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-primary/15 text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon
                    className={cn(
                      'h-4 w-4 shrink-0',
                      isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
                    )}
                  />
                  <div className="flex flex-col leading-tight">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-[11px] text-muted-foreground">{item.description}</span>
                  </div>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-border pt-4 text-[11px] text-muted-foreground">
          <div className="font-mono">v0.2 · local</div>
          <div className="mt-1">No cloud · AGPL-3.0</div>
        </div>
      </aside>

      <main className="flex-1 min-w-0 px-4 py-6 md:px-8 md:py-8">
        <Outlet />
      </main>
    </div>
  );
}
