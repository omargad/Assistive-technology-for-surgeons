/**
 * Design tokens for SurgeonPulse.
 *
 * Design language: calm, clinical, high contrast. Three palettes:
 * - `light`: default daytime UI.
 * - `dark`: follows the system dark appearance.
 * - `or`:   "OR mode" for the live screen in dark laparoscopic / robotic
 *           theatres — near-black background, desaturated accents and no pure
 *           white, to minimise glare while staying readable from 1–2 m.
 *
 * All text/background pairs were chosen to meet WCAG 2.2 AA (≥ 4.5:1 for body
 * text, ≥ 3:1 for large text and UI component boundaries).
 */

export type ThemeMode = 'light' | 'dark' | 'or';

export interface ThemeColors {
  /** Screen background. */
  bg: string;
  /** Card / sheet surface. */
  surface: string;
  /** Recessed surface (inputs, segmented control track, table stripes). */
  surfaceAlt: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  /** Lowest-emphasis text that still meets AA on `surface`. */
  textFaint: string;
  primary: string;
  onPrimary: string;
  primarySoft: string;
  danger: string;
  onDanger: string;
  dangerSoft: string;
  warning: string;
  onWarning: string;
  warningSoft: string;
  success: string;
  successSoft: string;
  info: string;
  infoSoft: string;
  focus: string;
  /** Modal scrim. */
  overlay: string;
  /** Toast / snackbar background (inverted surface). */
  inverse: string;
  onInverse: string;
  inverseAction: string;
  chartGrid: string;
  chartAxis: string;
  chartLine: string;
  chartBaseline: string;
  chartThreshold: string;
  chartSecondary: string;
  /** Five-step ramp from calm to very high effort, used for heart-rate zones. */
  zoneRamp: readonly [string, string, string, string, string];
}

const light: ThemeColors = {
  bg: '#F4F6F9',
  surface: '#FFFFFF',
  surfaceAlt: '#EBEFF4',
  border: '#D5DCE4',
  borderStrong: '#8A96A5',
  text: '#0E1726',
  textMuted: '#4A5565',
  textFaint: '#5F6B7A',
  primary: '#0B5CAD',
  onPrimary: '#FFFFFF',
  primarySoft: '#E3EEFA',
  danger: '#B42318',
  onDanger: '#FFFFFF',
  dangerSoft: '#FDECEA',
  warning: '#8A4B00',
  onWarning: '#FFFFFF',
  warningSoft: '#FFF3E0',
  success: '#08703F',
  successSoft: '#E5F5EC',
  info: '#0B5CAD',
  infoSoft: '#E3EEFA',
  focus: '#2E90FA',
  overlay: 'rgba(8, 13, 22, 0.5)',
  inverse: '#1C2532',
  onInverse: '#F3F6FA',
  inverseAction: '#8CC4FF',
  chartGrid: '#E3E8EE',
  chartAxis: '#5F6B7A',
  chartLine: '#B3123A',
  chartBaseline: '#4A5565',
  chartThreshold: '#B54708',
  chartSecondary: '#0B5CAD',
  zoneRamp: ['#067647', '#4D7C0F', '#946200', '#C4320A', '#A0153E'],
};

const dark: ThemeColors = {
  bg: '#0B1016',
  surface: '#141B24',
  surfaceAlt: '#1C2531',
  border: '#2A3543',
  borderStrong: '#5B6B7E',
  text: '#E8EDF3',
  textMuted: '#A7B3C2',
  textFaint: '#8E9AAB',
  primary: '#5AA7F0',
  onPrimary: '#06121F',
  primarySoft: '#13304D',
  danger: '#F97066',
  onDanger: '#1A0605',
  dangerSoft: '#3A1512',
  warning: '#FDB022',
  onWarning: '#1F1400',
  warningSoft: '#33260A',
  success: '#47CD89',
  successSoft: '#0F2E1F',
  info: '#5AA7F0',
  infoSoft: '#13304D',
  focus: '#84CAFF',
  overlay: 'rgba(0, 0, 0, 0.6)',
  inverse: '#E8EDF3',
  onInverse: '#0E1726',
  inverseAction: '#0B5CAD',
  chartGrid: '#243040',
  chartAxis: '#A7B3C2',
  chartLine: '#FF6B81',
  chartBaseline: '#A7B3C2',
  chartThreshold: '#FDB022',
  chartSecondary: '#5AA7F0',
  zoneRamp: ['#47CD89', '#A6D35E', '#FDB022', '#FB8A3C', '#F97066'],
};

const or: ThemeColors = {
  bg: '#030507',
  surface: '#0B0F14',
  surfaceAlt: '#121920',
  border: '#1E2732',
  borderStrong: '#4A5868',
  text: '#D9DEE5',
  textMuted: '#9AA5B3',
  textFaint: '#7E8A99',
  primary: '#7FA9CF',
  onPrimary: '#050A10',
  primarySoft: '#14222F',
  danger: '#DE7B73',
  onDanger: '#120504',
  dangerSoft: '#2A1311',
  warning: '#D8AA55',
  onWarning: '#140E02',
  warningSoft: '#261C0B',
  success: '#7DBF9A',
  successSoft: '#0F2219',
  info: '#7FA9CF',
  infoSoft: '#14222F',
  focus: '#9CC3E8',
  overlay: 'rgba(0, 0, 0, 0.7)',
  // Snackbars stay dark in OR mode: a light surface would flash in a dark theatre.
  inverse: '#1B232D',
  onInverse: '#D9DEE5',
  inverseAction: '#9CC3E8',
  chartGrid: '#18202A',
  chartAxis: '#8D99A8',
  chartLine: '#DE8590',
  chartBaseline: '#8D99A8',
  chartThreshold: '#D8AA55',
  chartSecondary: '#7FA9CF',
  zoneRamp: ['#7FBF9C', '#A9C27A', '#D8B25A', '#DB8A55', '#DE7B73'],
};

export const palettes: Readonly<Record<ThemeMode, ThemeColors>> = { light, dark, or };

/** 4-pt spacing scale. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/** Font sizes (points). Body text respects Dynamic Type via `allowFontScaling`. */
export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
  display: 40,
  /** Live-screen heart rate: ≥ 96 pt so it is readable from 1–2 m. */
  hero: 112,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  heavy: '800',
} as const;

export const layout = {
  /** Minimum accessible touch target (pt). */
  minTouch: 44,
  /** Live-screen phase/event buttons (pt). */
  bigTouch: 64,
  /** Centred content width on tablets and the web. */
  maxContentWidth: 720,
} as const;
