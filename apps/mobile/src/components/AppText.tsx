/**
 * Themed text. Variants map onto the type scale; `tone` maps onto semantic
 * colours. Dynamic Type is respected (`allowFontScaling`), with a cap on the
 * largest variants so layouts do not break.
 */
import { Text, type TextProps, type TextStyle } from 'react-native';

import { useTheme, type Theme } from '@/theme';

export type TextVariant =
  | 'hero'
  | 'display'
  | 'title'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'caption'
  | 'overline';

export type TextTone =
  | 'default'
  | 'muted'
  | 'faint'
  | 'primary'
  | 'danger'
  | 'warning'
  | 'success'
  | 'onPrimary'
  | 'inverse';

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  tone?: TextTone;
  /** Explicit colour (overrides `tone`). */
  color?: string;
  align?: TextStyle['textAlign'];
  /** Tabular (monospaced) digits for numbers that update in place. */
  tabular?: boolean;
  weight?: keyof Theme['fontWeight'];
}

function variantStyle(theme: Theme, variant: TextVariant): TextStyle {
  const { fontSize: fs, fontWeight: fw } = theme;
  switch (variant) {
    case 'hero':
      return { fontSize: fs.hero, lineHeight: fs.hero * 1.05, fontWeight: fw.bold, letterSpacing: -2 };
    case 'display':
      return { fontSize: fs.display, lineHeight: fs.display * 1.15, fontWeight: fw.bold, letterSpacing: -0.5 };
    case 'title':
      return { fontSize: fs.xxl, lineHeight: fs.xxl * 1.2, fontWeight: fw.bold };
    case 'heading':
      return { fontSize: fs.xl, lineHeight: fs.xl * 1.25, fontWeight: fw.semibold };
    case 'subheading':
      return { fontSize: fs.lg, lineHeight: fs.lg * 1.3, fontWeight: fw.semibold };
    case 'bodyStrong':
      return { fontSize: fs.md, lineHeight: fs.md * 1.4, fontWeight: fw.semibold };
    case 'label':
      return { fontSize: fs.sm, lineHeight: fs.sm * 1.35, fontWeight: fw.medium };
    case 'caption':
      return { fontSize: fs.xs, lineHeight: fs.xs * 1.4, fontWeight: fw.regular };
    case 'overline':
      return {
        fontSize: fs.xs,
        lineHeight: fs.xs * 1.4,
        fontWeight: fw.semibold,
        letterSpacing: 0.8,
        textTransform: 'uppercase',
      };
    case 'body':
    default:
      return { fontSize: fs.md, lineHeight: fs.md * 1.45, fontWeight: fw.regular };
  }
}

export function toneColor(theme: Theme, tone: TextTone): string {
  const c = theme.colors;
  switch (tone) {
    case 'muted':
      return c.textMuted;
    case 'faint':
      return c.textFaint;
    case 'primary':
      return c.primary;
    case 'danger':
      return c.danger;
    case 'warning':
      return c.warning;
    case 'success':
      return c.success;
    case 'onPrimary':
      return c.onPrimary;
    case 'inverse':
      return c.onInverse;
    case 'default':
    default:
      return c.text;
  }
}

const HEADER_VARIANTS: ReadonlySet<TextVariant> = new Set(['display', 'title', 'heading']);

export function AppText({
  variant = 'body',
  tone = 'default',
  color,
  align,
  tabular,
  weight,
  style,
  accessibilityRole,
  maxFontSizeMultiplier,
  ...rest
}: AppTextProps) {
  const theme = useTheme();
  const big = variant === 'hero' || variant === 'display';
  return (
    <Text
      allowFontScaling
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? (big ? 1.2 : 2)}
      accessibilityRole={accessibilityRole ?? (HEADER_VARIANTS.has(variant) ? 'header' : undefined)}
      style={[
        variantStyle(theme, variant),
        { color: color ?? toneColor(theme, tone) },
        align ? { textAlign: align } : null,
        tabular ? { fontVariant: ['tabular-nums'] } : null,
        weight ? { fontWeight: theme.fontWeight[weight] } : null,
        style,
      ]}
      {...rest}
    />
  );
}
