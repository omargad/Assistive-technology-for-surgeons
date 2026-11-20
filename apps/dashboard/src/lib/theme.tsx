/**
 * Light/dark theme.
 *
 * The UI is styled with CSS variables (`styles/tokens.css`) that follow
 * `prefers-color-scheme` unless the user picks a theme, which is stamped on
 * `<html data-theme="…">` and remembered in `localStorage`. Charts need
 * concrete colours for SVG attributes, so the resolved palette is also
 * exposed here (kept in sync with tokens.css).
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { CHART_COLORS } from './chartColors';
import type { ColorScheme } from './chartColors';
import { readPref, STORAGE_KEYS, writePref } from './storage';
import { ThemeContext } from './useTheme';
import type { ThemePreference } from './useTheme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeScheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(DARK_QUERY);
  // Safari < 14 only supports the deprecated addListener API.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

function systemScheme(): ColorScheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function readPreference(): ThemePreference {
  const v = readPref(STORAGE_KEYS.theme);
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** Provides the theme preference, the resolved scheme and chart colours. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const system = useSyncExternalStore(subscribeScheme, systemScheme, () => 'light' as ColorScheme);
  const scheme: ColorScheme = preference === 'system' ? system : preference;

  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'system') delete root.dataset.theme;
    else root.dataset.theme = preference;
  }, [preference]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    writePref(STORAGE_KEYS.theme, p === 'system' ? null : p);
  }, []);

  const value = useMemo(
    () => ({ preference, scheme, colors: CHART_COLORS[scheme], setPreference }),
    [preference, scheme, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
