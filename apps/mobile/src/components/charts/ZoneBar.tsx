/**
 * Time-in-zone stacked horizontal bar with a legend (minutes and %). Input is
 * `SessionSummary.zones` (core `timeInZones`).
 */
import { StyleSheet, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

import { formatDuration } from '@surgeonpulse/core';
import type { ZoneTime } from '@surgeonpulse/core';

import { useStyles, useTheme, zoneColor, type Theme } from '@/theme';

import { AppText } from '../AppText';
import { ChartFrame } from './ChartFrame';

export interface ZoneBarProps {
  zones: readonly ZoneTime[];
  title?: string;
  subtitle?: string;
  height?: number;
  initialWidth?: number;
  testID?: string;
}

export function describeZones(zones: readonly ZoneTime[]): string {
  const total = zones.reduce((a, z) => a + z.seconds, 0);
  if (total <= 0) return 'Time in heart-rate zones: no data.';
  return `Time in heart-rate zones: ${zones.map((z) => `${z.label} ${Math.round(z.fraction * 100)}%`).join(', ')}.`;
}

export function ZoneBar({ zones, title, subtitle, height = 22, initialWidth, testID }: ZoneBarProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const total = zones.reduce((a, z) => a + z.seconds, 0);

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      summary={describeZones(zones)}
      height={height}
      empty={total <= 0}
      emptyMessage="Zones need a baseline or a known max heart rate"
      initialWidth={initialWidth}
      testID={testID}
      footer={
        <View style={styles.legend} aria-hidden>
          {zones.map((z, i) => (
            <View key={z.id} style={styles.legendRow}>
              <View style={[styles.swatch, { backgroundColor: zoneColor(theme, i, zones.length) }]} />
              <AppText variant="label" style={styles.legendLabel} numberOfLines={1}>
                {z.label}
              </AppText>
              <AppText variant="label" tone="muted" tabular>
                {formatDuration(z.seconds)}
              </AppText>
              <AppText variant="label" tabular style={styles.pct}>
                {Math.round(z.fraction * 100)}%
              </AppText>
            </View>
          ))}
        </View>
      }
    >
      {(width) => {
        let acc = 0;
        return (
          <Svg width={width} height={height}>
            <Rect x={0} y={0} width={width} height={height} rx={6} fill={theme.colors.surfaceAlt} />
            {zones.map((z, i) => {
              const w = total > 0 ? (z.seconds / total) * width : 0;
              const x0 = acc;
              acc += w;
              if (w <= 0) return null;
              return (
                <Rect
                  key={z.id}
                  x={x0}
                  y={0}
                  width={Math.max(w - (i < zones.length - 1 ? 1 : 0), 0.5)}
                  height={height}
                  fill={zoneColor(theme, i, zones.length)}
                />
              );
            })}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    legend: { gap: t.space.xs },
    legendRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    swatch: { width: 12, height: 12, borderRadius: 3 },
    legendLabel: { flex: 1 },
    pct: { minWidth: 40, textAlign: 'right' },
  });
