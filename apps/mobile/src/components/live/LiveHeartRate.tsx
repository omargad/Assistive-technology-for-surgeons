/**
 * The big live heart-rate readout: zone-coloured digits (≥ 96 pt), a trend
 * arrow, the zone name and a 10-minute sparkline. For timed (health-store)
 * sessions it shows the elapsed time and an import note instead.
 */
import { StyleSheet, View } from 'react-native';

import { formatClock } from '@surgeonpulse/core';
import type { HeartRateSample, ZoneDefinition } from '@surgeonpulse/core';

import type { HrTrend } from '@/hooks/useHrTrend';
import { colorForBpm, useStyles, useTheme, zoneIndexForBpm, type Theme } from '@/theme';

import { AppText } from '../AppText';
import { Icon, type IconName } from '../Icon';
import { Sparkline } from '../charts/Sparkline';

const TREND: Record<HrTrend, { icon: IconName; spoken: string }> = {
  up: { icon: 'arrow-up', spoken: 'rising' },
  down: { icon: 'arrow-down', spoken: 'falling' },
  flat: { icon: 'remove', spoken: 'steady' },
};

export interface LiveHeartRateProps {
  bpm: number | null;
  trend: HrTrend;
  zones: readonly ZoneDefinition[];
  samples: readonly HeartRateSample[];
  baselineBpm?: number | null;
  timedOnly?: boolean;
  elapsedMs: number;
  /** Compact sizing for short landscape screens. */
  compact?: boolean;
  /** Extra-large digits for tablets / desktop (readable from further away). */
  large?: boolean;
}

export function LiveHeartRate({ bpm, trend, zones, samples, baselineBpm, timedOnly, elapsedMs, compact, large }: LiveHeartRateProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);

  if (timedOnly) {
    return (
      <View style={styles.root} accessible accessibilityLabel={`Elapsed ${formatClock(elapsedMs)}. Heart rate will be imported after the case.`}>
        <AppText variant="overline" tone="muted">
          Elapsed
        </AppText>
        <AppText variant="hero" tabular numberOfLines={1} adjustsFontSizeToFit style={compact ? styles.heroCompact : styles.heroClock}>
          {formatClock(elapsedMs)}
        </AppText>
        <View style={styles.note}>
          <Icon name="watch-outline" size={20} color={theme.colors.info} />
          <AppText variant="bodyStrong" tone="muted" style={styles.flex}>
            HR will be imported after the case
          </AppText>
        </View>
      </View>
    );
  }

  const value = bpm != null && Number.isFinite(bpm) ? Math.round(bpm) : null;
  const color = colorForBpm(theme, zones, value);
  const zoneIdx = value != null ? zoneIndexForBpm(zones, value) : -1;
  const zone = zoneIdx >= 0 ? zones[zoneIdx] : undefined;
  const t = TREND[trend];
  const spoken =
    value != null
      ? `Heart rate ${value} beats per minute, ${t.spoken}${zone ? `, zone ${zone.label}` : ''}`
      : 'Waiting for heart rate';

  return (
    <View style={styles.root}>
      <View style={styles.hrRow} accessible accessibilityLabel={spoken} testID="live-hr">
        <AppText
          variant="hero"
          tabular
          color={color}
          numberOfLines={1}
          style={compact ? styles.heroCompact : large ? styles.heroLarge : null}
          maxFontSizeMultiplier={1}
        >
          {value ?? '--'}
        </AppText>
        <View style={styles.side}>
          <Icon name={t.icon} size={compact ? 28 : large ? 48 : 36} color={value != null ? color : theme.colors.textFaint} />
          <AppText variant="subheading" tone="muted">
            bpm
          </AppText>
        </View>
      </View>
      {zone ? (
        <AppText variant="label" color={color} aria-hidden>
          {zone.label}
          {typeof baselineBpm === 'number' && value != null
            ? ` · ${value - Math.round(baselineBpm) >= 0 ? '+' : '−'}${Math.abs(value - Math.round(baselineBpm))} vs rest`
            : ''}
        </AppText>
      ) : null}
      <Sparkline samples={samples} height={compact ? 44 : large ? 96 : 56} baselineBpm={baselineBpm} color={theme.colors.chartLine} testID="live-sparkline" />
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { gap: t.space.xs, alignItems: 'stretch' },
    hrRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.md },
    side: { alignItems: 'center', gap: 2 },
    heroCompact: { fontSize: 96, lineHeight: 100 },
    heroLarge: { fontSize: 168, lineHeight: 172, letterSpacing: -4 },
    heroClock: { fontSize: 72, lineHeight: 80 },
    note: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    flex: { flex: 1 },
  });
