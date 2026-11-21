/**
 * One metric per session (chronological; from core `metricSeries`) with an
 * ordinary-least-squares trend line over session order. Core `trendEvidence`
 * tests the slope (two-sided p < 0.05), and the text calls a trend "rising" or
 * "falling" only when it is unlikely to be chance; otherwise it says there is no
 * clear trend, so ordinary session-to-session variation is not presented as a
 * pattern (RV-1).
 */
import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';

import { trendEvidence } from '@surgeonpulse/core';

import { formatShortDate, useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from '../AppText';
import { ChartFrame } from './ChartFrame';
import { AxisUnitLabel, ChartText } from './ChartText';
import { linePath, linearScale, niceDomain, tickSpacingPx, topTickPx } from './scale';

export interface TrendPoint {
  sessionId: string;
  t: number;
  value: number;
}

export interface TrendChartProps {
  points: readonly TrendPoint[];
  /** Metric name, e.g. "Mean HR change". */
  label: string;
  unit: string;
  decimals?: number;
  title?: string;
  subtitle?: string;
  height?: number;
  initialWidth?: number;
  testID?: string;
}

const PAD_LEFT = 44;
const PAD_RIGHT = 14;
const PAD_TOP = 12;
const PAD_BOTTOM = 26;

function trendOf(points: readonly TrendPoint[]) {
  return trendEvidence(points.map((p, i) => ({ x: i, y: p.value })));
}

export function describeTrend(points: readonly TrendPoint[], label: string, unit: string, decimals = 0): string {
  if (points.length === 0) return `${label}: no sessions with this metric yet.`;
  const first = points[0];
  const last = points[points.length - 1];
  const fmt = (v: number) => `${v.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
  let s = `${label} across ${points.length} session${points.length === 1 ? '' : 's'}`;
  if (first && last) s += `, from ${fmt(first.value)} to ${fmt(last.value)}`;
  const trend = trendOf(points);
  if (trend && points.length >= 3) {
    const flat = Math.abs(trend.slope) < 10 ** -decimals / 2;
    if (trend.significant && !flat) {
      const dir = trend.slope > 0 ? 'rising' : 'falling';
      s += `; trend ${dir} by about ${Math.abs(trend.slope).toFixed(Math.max(1, decimals))} ${unit} per session (unlikely to be chance, p < 0.05)`;
    } else {
      s += '; no clear trend (the changes could be ordinary variation between sessions)';
    }
  }
  return `${s}.`;
}

export function TrendChart({
  points,
  label,
  unit,
  decimals = 0,
  title,
  subtitle,
  height = 200,
  initialWidth,
  testID,
}: TrendChartProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const c = theme.colors;
  const trend = useMemo(() => (points.length >= 2 ? trendOf(points) : null), [points]);

  const caption =
    trend && points.length >= 3
      ? `Trend ${trend.slope >= 0 ? '+' : '−'}${Math.abs(trend.slope).toFixed(Math.max(1, decimals))} ${unit} per session (R² ${trend.r2.toFixed(2)}, n = ${trend.n}; ${
          trend.significant ? 'p < 0.05' : 'not statistically clear, could be chance'
        }).`
      : points.length > 0
        ? 'A trend line appears after three sessions.'
        : '';

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      summary={describeTrend(points, label, unit, decimals)}
      height={height}
      empty={points.length === 0}
      emptyMessage={`No sessions with “${label}” yet`}
      initialWidth={initialWidth}
      testID={testID}
      footer={
        caption ? (
          <AppText variant="caption" tone="muted" style={styles.caption}>
            {caption}
          </AppText>
        ) : null
      }
    >
      {(width) => {
        const plotW = Math.max(10, width - PAD_LEFT - PAD_RIGHT);
        const bottom = height - PAD_BOTTOM;
        const vals = points.map((p) => p.value);
        const domain = niceDomain(Math.min(...vals), Math.max(...vals), 4);
        const n = points.length;
        const x = n <= 1 ? () => PAD_LEFT + plotW / 2 : linearScale(0, n - 1, PAD_LEFT + 6, PAD_LEFT + plotW - 6);
        const y = linearScale(domain.min, domain.max, bottom, PAD_TOP);
        const line = linePath(points.map((p, i) => ({ x: x(i), y: y(p.value) })));
        const showTrend = trend && n >= 3;
        const firstT = points[0]?.t;
        const lastT = points[n - 1]?.t;
        return (
          <Svg width={width} height={height}>
            {domain.ticks.map((v) => (
              <G key={`y-${v}`}>
                <Line x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(v)} y2={y(v)} stroke={c.chartGrid} strokeWidth={1} />
                <ChartText x={PAD_LEFT - 6} y={y(v) + 4} fontSize={10} fill={c.chartAxis} textAnchor="end">
                  {v.toFixed(Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0)}
                </ChartText>
              </G>
            ))}
            {domain.min < 0 && domain.max > 0 ? (
              <Line x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(0)} y2={y(0)} stroke={c.chartAxis} strokeWidth={1} />
            ) : null}
            <Path d={line} stroke={c.border} strokeWidth={1.5} fill="none" />
            {showTrend ? (
              <Line
                x1={x(0)}
                x2={x(n - 1)}
                y1={y(trend.intercept)}
                y2={y(trend.intercept + trend.slope * (n - 1))}
                stroke={c.primary}
                strokeWidth={2}
                strokeDasharray="6 4"
              />
            ) : null}
            {points.map((p, i) => (
              <Circle key={p.sessionId} cx={x(i)} cy={y(p.value)} r={4} fill={c.chartSecondary} stroke={c.surface} strokeWidth={1.5} />
            ))}
            {firstT != null ? (
              <ChartText x={PAD_LEFT} y={height - 6} fontSize={10} fill={c.chartAxis}>
                {formatShortDate(firstT)}
              </ChartText>
            ) : null}
            {lastT != null && n > 1 ? (
              <ChartText x={PAD_LEFT + plotW} y={height - 6} fontSize={10} fill={c.chartAxis} textAnchor="end">
                {formatShortDate(lastT)}
              </ChartText>
            ) : null}
            <AxisUnitLabel
              unit={unit}
              axisRight={PAD_LEFT - 6}
              topTickY={topTickPx(domain.ticks, y, PAD_TOP)}
              tickSpacing={tickSpacingPx(domain.ticks, y)}
              fill={c.chartAxis}
            />
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({ caption: { marginTop: t.space.xxs } });
