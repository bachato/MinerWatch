import { useCallback, useEffect, useState } from 'react';

// MinerWatch's theme switch. Two values for now ("dark" | "light");
// the toggle in AppShell flips between them and persists the choice
// in localStorage so the next page load uses the same scheme. The
// inline boot script in index.html reads the same key before React
// mounts to avoid a first-paint flash.
//
// Why a class on <html> instead of a Context provider?
//   - Tailwind's `darkMode: ['class']` config keys off this class, so
//     any `dark:` utilities in components Just Work.
//   - shadcn components read CSS variables that we define under
//     `:root` (light) and `.dark` (dark) in index.css, so flipping
//     the class is enough to re-skin the whole tree with zero
//     per-component changes.

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'mw-theme';
const META_THEME_COLOR = '#0f1115'; // dark bg
const META_THEME_COLOR_LIGHT = '#ffffff';

function readStored(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  // Keep the iOS / Android status-bar tint in sync with the theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute(
      'content',
      theme === 'dark' ? META_THEME_COLOR : META_THEME_COLOR_LIGHT,
    );
  }
}

export function useTheme(): {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(readStored);

  // Re-apply on mount in case anything else stomped the class while
  // mounting (e.g. React Strict-Mode dev double-render). The boot
  // script already did the same on first paint, so this is a no-op
  // in the common path.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Sync across tabs: when another tab flips the theme, mirror it
  // here so a multi-window MinerWatch session stays coherent.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      const next: Theme = e.newValue === 'light' ? 'light' : 'dark';
      setThemeState(next);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private-mode Safari: silently drop the persistence step.
    }
    applyTheme(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
