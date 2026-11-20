/**
 * Theme context and hook (the provider is `ThemeProvider` in `theme.tsx`).
 */
import { createContext, useContext } from 'react';
import { CHART_COLORS } from './chartColors';
import type { ChartColors, ColorScheme } from './chartColors';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface ThemeContextValue {
  preference: ThemePreference;
  scheme: ColorScheme;
  colors: ChartColors;
  setPreference: (p: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Current theme. Falls back to light colours outside a provider (tests). */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx !== null) return ctx;
  return { preference: 'system', scheme: 'light', colors: CHART_COLORS.light, setPreference: () => {} };
}
