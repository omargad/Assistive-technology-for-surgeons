/**
 * Shared Recharts styling (tooltips, axes) derived from the theme colours.
 */
import type { CSSProperties } from 'react';
import type { ChartColors } from '../../lib/chartColors';

/** Shared tooltip styling for Recharts. */
export function tooltipStyles(colors: ChartColors): {
  contentStyle: CSSProperties;
  labelStyle: CSSProperties;
  itemStyle: CSSProperties;
  separator: string;
} {
  return {
    separator: ': ',
    contentStyle: {
      background: colors.tooltipBg,
      border: `1px solid ${colors.tooltipBorder}`,
      borderRadius: 6,
      color: colors.text,
      fontSize: 13,
      boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    },
    labelStyle: { color: colors.text, fontWeight: 600, marginBottom: 4 },
    itemStyle: { color: colors.text, padding: 0 },
  };
}

/** Shared axis props (recessive ink, tabular figures). */
export function axisProps(colors: ChartColors): {
  stroke: string;
  tick: { fill: string; fontSize: number };
  tickLine: { stroke: string };
} {
  return {
    stroke: colors.axis,
    tick: { fill: colors.textMuted, fontSize: 12 },
    tickLine: { stroke: colors.axis },
  };
}
