/**
 * The big live heart-rate readout: zone-coloured digits (≥ 96 pt), a trend
 * arrow, a one-line status (zone and difference from rest, "waiting" or
 * "signal lost") and a 10-minute sparkline. For timed (health-store) sessions it
 * shows the elapsed time and an import note instead.
 *
 * The status line and sparkline sit in a fixed-height "detail" area. The live
 * screen shows transient messages (the undo bar, hints, the signal-lost notice)
 * over that area through `overlay`, so they never cover a button and never move
 * the controls below.
 *
 * When `signalLost`, the stale value is not shown as current: the digits become
 * "--" in a faint colour and the status line gives the last reading.
 *
 * With `hidden` (Settings › "Show heart rate on the live screen" off) the HR is
 * recorded but not displayed: the panel shows the elapsed time instead.
 */
import type { ReactNode } from 'react';
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

/** Height of the one-line status under the digits. */
const STATUS_LINE = 20;

export type LiveHrSize = 'regular' | 'compact' | 'dense' | 'large';

/** Sparkline height per size; the detail area is the status line + gap + sparkline (≥ 56 pt for the undo bar). */
const SPARK: Record<LiveHrSize, number> = { regular: 56, compact: 44, dense: 36, large: 96 };

export function detailHeight(size: LiveHrSize, gap: number): number {
  return STATUS_LINE + gap + SPARK[size];
}

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
  /** Dense sizing for short portrait phones (smaller digits and sparkline). */
  dense?: boolean;
  /** Extra-large digits for tablets / desktop (readable from further away). */
  large?: boolean;
  /** No data for a while: show the last reading as stale instead of current. */
  signalLost?: boolean;
  /** Settings › "Show heart rate on the live screen" is off: HR is recorded but not displayed. */
  hidden?: boolean;
  /** Shown over the status line and sparkline (fixed-height area), e.g. the undo bar. */
  overlay?: ReactNode;
}

export function LiveHeartRate({
  bpm,
  trend,
  zones,
  samples,
  baselineBpm,
  timedOnly,
  elapsedMs,
  compact,
  dense,
  large,
  signalLost,
  hidden,
  overlay,
}: LiveHeartRateProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const size: LiveHrSize = compact ? 'compact' : dense ? 'dense' : large ? 'large' : 'regular';
  const detailStyle = { height: detailHeight(size, theme.space.xs) };
  const overlayView = overlay ? (
    <View style={styles.overlay} testID="live-hr-overlay">
      {overlay}
    </View>
  ) : null;

  if (timedOnly || hidden) {
    const note = timedOnly ? 'HR will be imported after the case' : 'Heart rate is recorded but not shown';
    return (
      <View style={styles.root} testID={hidden && !timedOnly ? 'live-hr-hidden' : undefined}>
        <View accessible accessibilityLabel={`Elapsed ${formatClock(elapsedMs)}. ${timedOnly ? 'Heart rate will be imported after the case.' : 'Heart rate is recorded but not shown on this screen.'}`}>
          <AppText variant="overline" tone="muted">
            Elapsed
          </AppText>
          <AppText variant="hero" tabular numberOfLines={1} adjustsFontSizeToFit style={compact || dense ? styles.heroCompact : styles.heroClock}>
            {formatClock(elapsedMs)}
          </AppText>
        </View>
        <View style={[styles.detail, detailStyle]}>
          <View style={styles.note}>
            <Icon name={timedOnly ? 'watch-outline' : 'eye-off-outline'} size={20} color={theme.colors.info} />
            <AppText variant="bodyStrong" tone="muted" style={styles.flex}>
              {note}
            </AppText>
          </View>
          {overlayView}
        </View>
      </View>
    );
  }

  const latest = bpm != null && Number.isFinite(bpm) ? Math.round(bpm) : null;
  // A value that stopped updating is not "the heart rate now".
  const value = signalLost ? null : latest;
  const color = signalLost ? theme.colors.textFaint : colorForBpm(theme, zones, value);
  const zoneIdx = value != null ? zoneIndexForBpm(zones, value) : -1;
  const zone = zoneIdx >= 0 ? zones[zoneIdx] : undefined;
  const t = TREND[trend];
  const delta =
    typeof baselineBpm === 'number' && value != null
      ? `${value - Math.round(baselineBpm) >= 0 ? '+' : '−'}${Math.abs(value - Math.round(baselineBpm))} vs rest`
      : null;

  let spoken: string;
  let status: { text: string; color?: string; tone?: 'muted' | 'warning' } | null;
  if (signalLost) {
    spoken = `Heart-rate signal lost${latest != null ? `. Last reading ${latest} beats per minute` : ''}`;
    status = { text: latest != null ? `No signal · last ${latest} bpm` : 'No signal', tone: 'warning' };
  } else if (value == null) {
    spoken = 'Waiting for heart rate';
    status = { text: 'Waiting for heart rate…', tone: 'muted' };
  } else {
    spoken = `Heart rate ${value} beats per minute, ${t.spoken}${zone ? `, zone ${zone.label}` : ''}`;
    status = zone ? { text: `${zone.label}${delta ? ` · ${delta}` : ''}`, color } : delta ? { text: delta, tone: 'muted' } : null;
  }

  const heroStyle = compact || dense ? styles.heroCompact : large ? styles.heroLarge : null;
  return (
    <View style={styles.root}>
      <View style={styles.hrRow} accessible accessibilityLabel={spoken} testID="live-hr">
        <AppText variant="hero" tabular color={color} numberOfLines={1} style={heroStyle} maxFontSizeMultiplier={1}>
          {value ?? '--'}
        </AppText>
        <View style={styles.side}>
          <Icon
            name={signalLost ? 'pulse' : t.icon}
            size={compact || dense ? 28 : large ? 48 : 36}
            color={value != null ? color : theme.colors.textFaint}
          />
          <AppText variant="subheading" tone="muted">
            bpm
          </AppText>
        </View>
      </View>
      <View style={[styles.detail, detailStyle]}>
        <AppText
          variant="label"
          color={status?.color}
          tone={status?.color ? undefined : status?.tone}
          numberOfLines={1}
          maxFontSizeMultiplier={1.3}
          style={styles.status}
          aria-hidden
          testID="live-hr-status"
        >
          {status?.text ?? ' '}
        </AppText>
        <Sparkline
          samples={samples}
          height={SPARK[size]}
          baselineBpm={baselineBpm}
          color={theme.colors.chartLine}
          testID="live-sparkline"
        />
        {overlayView}
      </View>
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
    detail: { gap: t.space.xs, overflow: 'hidden', justifyContent: 'flex-start' },
    status: { height: STATUS_LINE, lineHeight: STATUS_LINE },
    overlay: { ...StyleSheet.absoluteFill, justifyContent: 'center' },
    note: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    flex: { flex: 1 },
  });
