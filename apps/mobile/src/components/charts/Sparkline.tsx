/**
 * Live-screen sparkline: the last `windowMs` (default 10 min) of heart rate,
 * resampled into 5-s buckets with core `resampleHr` (gaps break the line).
 * Early in a case the window shrinks to the data recorded so far (at least
 * `minWindowMs`), so the line fills the width instead of hugging the edge.
 */
import { useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { hrStats, resampleHr, sliceByTime } from '@surgeonpulse/core';
import type { HeartRateSample } from '@surgeonpulse/core';

import { useTheme } from '@/theme';

import { linePath, linearScale } from './scale';

export interface SparklineProps {
  samples: readonly HeartRateSample[];
  /** Window length (ms). Default 10 minutes. */
  windowMs?: number;
  /** Shortest window while little data exists (ms). Default 1 minute. */
  minWindowMs?: number;
  /** Right edge of the window; defaults to the last sample time. */
  now?: number;
  height?: number;
  color?: string;
  /** Optional reference line (e.g. resting baseline). */
  baselineBpm?: number | null;
  initialWidth?: number;
  testID?: string;
}

const BUCKET_MS = 5000;

export function describeSparkline(samples: readonly HeartRateSample[], windowMs: number): string {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  const stats = hrStats(samples);
  if (!stats) return `Heart-rate trend, last ${minutes} minutes: no data yet.`;
  return `Heart-rate trend, last ${minutes} minutes: ${Math.round(stats.min)} to ${Math.round(stats.max)} bpm.`;
}

export function Sparkline({
  samples,
  windowMs = 10 * 60_000,
  minWindowMs = 60_000,
  now,
  height = 56,
  color,
  baselineBpm,
  initialWidth = 280,
  testID,
}: SparklineProps) {
  const theme = useTheme();
  const [width, setWidth] = useState(initialWidth);
  const end = now ?? samples[samples.length - 1]?.t ?? 0;
  const first = samples[0]?.t ?? end;
  const span = Math.min(windowMs, Math.max(minWindowMs, end - first));
  const start = end - span;

  const windowed = useMemo(() => sliceByTime(samples, start, end + 1), [samples, start, end]);
  const series = useMemo(
    () => (windowed.length ? resampleHr(windowed, BUCKET_MS, { start, end }) : []),
    [windowed, start, end],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0 && w !== width) setWidth(w);
  };

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of series) {
    if (b.bpm == null) continue;
    lo = Math.min(lo, b.bpm);
    hi = Math.max(hi, b.bpm);
  }
  if (typeof baselineBpm === 'number') {
    lo = Math.min(lo, baselineBpm);
    hi = Math.max(hi, baselineBpm);
  }
  const hasData = Number.isFinite(lo);
  if (hasData && hi - lo < 10) {
    const mid = (hi + lo) / 2;
    lo = mid - 5;
    hi = mid + 5;
  }
  const pad = 4;
  const x = linearScale(start, end, pad, width - pad);
  const y = linearScale(lo, hi, height - pad, pad);
  const points = series.map((b) => ({ x: x(b.t + BUCKET_MS / 2), y: b.bpm == null ? null : y(b.bpm) }));
  const last = [...points].reverse().find((p) => p.y != null);
  const stroke = color ?? theme.colors.chartLine;

  return (
    <View
      onLayout={onLayout}
      style={{ width: '100%', height }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={describeSparkline(windowed, span)}
      testID={testID}
    >
      {hasData ? (
        <Svg width={width} height={height}>
          {typeof baselineBpm === 'number' ? (
            <Line
              x1={pad}
              x2={width - pad}
              y1={y(baselineBpm)}
              y2={y(baselineBpm)}
              stroke={theme.colors.chartBaseline}
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          ) : null}
          <Path d={linePath(points)} stroke={stroke} strokeWidth={2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          {last && last.y != null ? <Circle cx={last.x} cy={last.y} r={4} fill={stroke} /> : null}
        </Svg>
      ) : null}
    </View>
  );
}
