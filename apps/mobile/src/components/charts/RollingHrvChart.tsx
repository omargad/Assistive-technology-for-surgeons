/**
 * Rolling HRV (RMSSD) over a session. Input is the output of core
 * `rollingHrv(session.rr)` — windows with too few clean beats are `null` and
 * break the line.
 */
import { useMemo } from 'react';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

import { PHASE_COLORS } from '@surgeonpulse/core';
import type { PhaseSegment } from '@surgeonpulse/core';

import { formatAxisTime, useTheme } from '@/theme';

import { ChartFrame } from './ChartFrame';
import { AxisUnitLabel, ChartText } from './ChartText';
import { clamp, isolatedPoints, linePath, linearScale, niceDomain, tickSpacingPx, timeTicks, topTickPx } from './scale';

export interface RollingHrvPoint {
  /** Window end (epoch ms). */
  t: number;
  rmssd: number | null;
}

export interface RollingHrvChartProps {
  points: readonly RollingHrvPoint[];
  startedAt: number;
  endedAt?: number;
  phases?: readonly PhaseSegment[];
  height?: number;
  title?: string;
  subtitle?: string;
  initialWidth?: number;
  testID?: string;
}

const PAD_LEFT = 40;
const PAD_RIGHT = 12;
const PAD_TOP = 10;
const PAD_BOTTOM = 24;

export function describeRollingHrv(points: readonly RollingHrvPoint[]): string {
  const vals = points.map((p) => p.rmssd).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (vals.length === 0) return 'Rolling HRV chart: not enough beat-to-beat data.';
  const lo = Math.round(Math.min(...vals));
  const hi = Math.round(Math.max(...vals));
  const first = vals[0] ?? 0;
  const last = vals[vals.length - 1] ?? 0;
  const dir = last > first * 1.1 ? 'rising' : last < first * 0.9 ? 'falling' : 'fairly steady';
  return `Rolling HRV (RMSSD) ranged from ${lo} to ${hi} milliseconds over ${vals.length} one-minute windows, ${dir} overall.`;
}

export function RollingHrvChart({
  points,
  startedAt,
  endedAt,
  phases = [],
  height = 170,
  title,
  subtitle,
  initialWidth,
  testID,
}: RollingHrvChartProps) {
  const theme = useTheme();
  const c = theme.colors;
  const valid = useMemo(() => points.filter((p) => p.rmssd != null), [points]);
  const end = endedAt ?? points[points.length - 1]?.t ?? startedAt + 60_000;
  const duration = Math.max(1000, end - startedAt);

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      summary={describeRollingHrv(points)}
      height={height}
      empty={valid.length === 0}
      emptyMessage="Not enough beat-to-beat (RR) data for rolling HRV"
      initialWidth={initialWidth}
      testID={testID}
    >
      {(width) => {
        const plotW = Math.max(10, width - PAD_LEFT - PAD_RIGHT);
        const bottom = height - PAD_BOTTOM;
        const vals = valid.map((p) => p.rmssd as number);
        const domain = niceDomain(Math.max(0, Math.min(...vals) - 5), Math.max(...vals) + 5, 4);
        const x = linearScale(startedAt, end, PAD_LEFT, PAD_LEFT + plotW);
        const y = linearScale(domain.min, domain.max, bottom, PAD_TOP);
        const pts = points.map((p) => ({ x: x(clamp(p.t, startedAt, end)), y: p.rmssd == null ? null : y(p.rmssd) }));
        const ticks = timeTicks(duration, Math.max(2, Math.floor(plotW / 70)));
        return (
          <Svg width={width} height={height}>
            {phases.map((seg) => {
              const x0 = x(clamp(seg.start, startedAt, end));
              const x1 = x(clamp(seg.end, startedAt, end));
              return (
                <Rect
                  key={`${seg.phase}-${seg.index}`}
                  x={x0}
                  y={PAD_TOP}
                  width={Math.max(0, x1 - x0)}
                  height={bottom - PAD_TOP}
                  fill={PHASE_COLORS[seg.phase]}
                  fillOpacity={theme.isDark ? 0.18 : 0.12}
                />
              );
            })}
            {domain.ticks.map((v) => (
              <G key={`y-${v}`}>
                <Line x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(v)} y2={y(v)} stroke={c.chartGrid} strokeWidth={1} />
                <ChartText x={PAD_LEFT - 6} y={y(v) + 4} fontSize={10} fill={c.chartAxis} textAnchor="end">
                  {String(Math.round(v))}
                </ChartText>
              </G>
            ))}
            <AxisUnitLabel
              unit="ms"
              axisRight={PAD_LEFT - 6}
              topTickY={topTickPx(domain.ticks, y, PAD_TOP)}
              tickSpacing={tickSpacingPx(domain.ticks, y)}
              fill={c.chartAxis}
            />
            <Path d={linePath(pts)} stroke={c.chartSecondary} strokeWidth={2} fill="none" strokeLinejoin="round" />
            {isolatedPoints(pts).map((p) => (
              <Circle key={`d-${p.x}`} cx={p.x} cy={p.y} r={2.5} fill={c.chartSecondary} />
            ))}
            <Line x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={bottom} y2={bottom} stroke={c.chartAxis} strokeWidth={1} />
            {ticks.map((tk) => {
              const tx = x(startedAt + tk);
              if (tx > PAD_LEFT + plotW + 0.5) return null;
              return (
                <ChartText key={`x-${tk}`} x={tx} y={height - 6} fontSize={10} fill={c.chartAxis} textAnchor="middle">
                  {formatAxisTime(tk, duration)}
                </ChartText>
              );
            })}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}
