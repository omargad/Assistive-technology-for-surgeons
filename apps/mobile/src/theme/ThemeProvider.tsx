/**
 * Theme context. The app follows the system colour scheme by default; a
 * nested `<ThemeProvider mode="or">` switches a subtree (the live screen) into
 * OR mode without affecting the rest of the app.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import {
  fontSize,
  fontWeight,
  layout,
  palettes,
  radius,
  space,
  type ThemeColors,
  type ThemeMode,
} from './tokens';

export interface Theme {
  mode: ThemeMode;
  /** True for `dark` and `or`. */
  isDark: boolean;
  colors: ThemeColors;
  space: typeof space;
  radius: typeof radius;
  fontSize: typeof fontSize;
  fontWeight: typeof fontWeight;
  layout: typeof layout;
}

function buildTheme(mode: ThemeMode): Theme {
  return {
    mode,
    isDark: mode !== 'light',
    colors: palettes[mode],
    space,
    radius,
    fontSize,
    fontWeight,
    layout,
  };
}

/** Pre-built themes (stable identities so memoised styles are reused). */
export const themes: Readonly<Record<ThemeMode, Theme>> = {
  light: buildTheme('light'),
  dark: buildTheme('dark'),
  or: buildTheme('or'),
};

const ThemeContext = createContext<Theme>(themes.light);

export interface ThemeProviderProps {
  /** Force a mode. When omitted the system colour scheme decides (light/dark). */
  mode?: ThemeMode;
  children: ReactNode;
}

export function ThemeProvider({ mode, children }: ThemeProviderProps) {
  const scheme = useColorScheme();
  const resolved: ThemeMode = mode ?? (scheme === 'dark' ? 'dark' : 'light');
  return <ThemeContext.Provider value={themes[resolved]}>{children}</ThemeContext.Provider>;
}

/** The active theme. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Memoised themed stylesheet:
 * `const styles = useStyles(makeStyles)` with
 * `const makeStyles = (t: Theme) => StyleSheet.create({...})`.
 * The factory must be a module-level function (stable identity).
 */
export function useStyles<T>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  return useMemo(() => factory(theme), [factory, theme]);
}
