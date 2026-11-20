/**
 * SVG text with the platform UI font. react-native-svg uses the native system
 * font on iOS/Android, but on the web an SVG <text> falls back to the
 * browser's serif default unless a family is given.
 */
import type { ComponentProps } from 'react';
import { Platform } from 'react-native';
import { Text as SvgText } from 'react-native-svg';

export const CHART_FONT_FAMILY = Platform.select({
  web: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  default: undefined,
});

export function ChartText(props: ComponentProps<typeof SvgText>) {
  return <SvgText fontFamily={CHART_FONT_FAMILY} {...props} />;
}

/** Vertical gap (px) between a tick label's baseline and the unit label under it. */
const UNIT_BELOW_TICK = 14;
/** Minimum tick spacing (px) that leaves room for the unit between two tick labels. */
const MIN_SPACING_FOR_UNIT = 24;

export interface AxisUnitLabelProps {
  unit: string;
  /** Right edge of the y-axis tick labels (they are drawn with textAnchor="end"). */
  axisRight: number;
  /** Pixel y of the top (highest-value) tick. */
  topTickY: number;
  /** Pixel distance between adjacent ticks (0 when there is a single tick). */
  tickSpacing: number;
  fill: string;
}

/**
 * Unit caption for a y-axis ("bpm", "ms"). It is right-aligned under the top
 * tick label, so it never collides with three-digit tick values in the narrow
 * left gutter. When ticks are too close for that, it sits just above the top
 * tick instead.
 */
export function AxisUnitLabel({ unit, axisRight, topTickY, tickSpacing, fill }: AxisUnitLabelProps) {
  if (!unit) return null;
  const below = tickSpacing >= MIN_SPACING_FOR_UNIT;
  const y = below ? topTickY + UNIT_BELOW_TICK : Math.max(9, topTickY - 6);
  return (
    <ChartText x={axisRight} y={y} fontSize={9} fill={fill} textAnchor="end">
      {unit}
    </ChartText>
  );
}
