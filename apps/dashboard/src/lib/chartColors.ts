/**
 * Chart colour palettes for the light and dark themes (kept in sync with
 * `styles/tokens.css`). Charts need concrete colours for SVG attributes.
 *
 * The categorical slots are a validated colour-vision-deficiency-safe order:
 * assign them in fixed order and fold extra groups into "Other".
 */
export type ColorScheme = 'light' | 'dark';

/** Colours used inside charts. */
export interface ChartColors {
  surface: string;
  text: string;
  textMuted: string;
  grid: string;
  axis: string;
  /** Primary data series (heart rate, single-series bars). */
  series: string;
  /** Comparison series (cohort median, trend lines). */
  comparison: string;
  /** Baseline reference line. */
  baseline: string;
  /** Episode threshold / attention reference. */
  threshold: string;
  /** Event marker lines. */
  marker: string;
  /** Categorical palette (fixed order; fold extra groups into "Other"). */
  categorical: readonly string[];
  /** Neutral colour for an "Other" group. */
  other: string;
  /** Ordinal ramp, low → high (zones). */
  ordinal: readonly string[];
  tooltipBg: string;
  tooltipBorder: string;
}

/** Validated categorical slots (light / dark steps of the same eight hues). */
const CATEGORICAL_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const CATEGORICAL_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];

export const CHART_COLORS: Readonly<Record<ColorScheme, ChartColors>> = {
  light: {
    surface: '#ffffff',
    text: '#17202b',
    textMuted: '#55606e',
    grid: '#e4e7eb',
    axis: '#c3c8cf',
    series: '#2a78d6',
    comparison: '#6b7480',
    baseline: '#55606e',
    threshold: '#b4432f',
    marker: '#4b5563',
    categorical: CATEGORICAL_LIGHT,
    other: '#9aa1ab',
    ordinal: ['#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'],
    tooltipBg: '#ffffff',
    tooltipBorder: '#c3c8cf',
  },
  dark: {
    surface: '#161c23',
    text: '#e8ecf1',
    textMuted: '#a4aebb',
    grid: '#29313b',
    axis: '#3c4652',
    series: '#5598e7',
    comparison: '#9aa3ae',
    baseline: '#a4aebb',
    threshold: '#ec835a',
    marker: '#b8c1cc',
    categorical: CATEGORICAL_DARK,
    other: '#7d8794',
    ordinal: ['#184f95', '#256abf', '#3987e5', '#5598e7', '#86b6ef', '#b7d3f6'],
    tooltipBg: '#1e252e',
    tooltipBorder: '#3c4652',
  },
};

/** Number of categorical colours before groups fold into "Other". */
export const MAX_COLOURED_GROUPS = 8;

/** Colour for the i-th group in a categorical chart; groups past the palette share the "Other" colour. */
export function categoricalColor(colors: ChartColors, index: number): string {
  return colors.categorical[index] ?? colors.other;
}
