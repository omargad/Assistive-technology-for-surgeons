import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useStyles, type Theme } from '@/theme';

import { AppText, type TextTone } from './AppText';

export interface StatTileProps {
  label: string;
  /** Pre-formatted value (use an em dash when unavailable). */
  value: string;
  unit?: string;
  /** Secondary line, e.g. "vs baseline 68 bpm". */
  detail?: string;
  tone?: TextTone;
  /** Spoken label; defaults to "label: value unit, detail". */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Compact metric tile for dashboards. */
export function StatTile({ label, value, unit, detail, tone = 'default', accessibilityLabel, style, testID }: StatTileProps) {
  const styles = useStyles(makeStyles);
  const spoken = accessibilityLabel ?? [`${label}: ${value}${unit ? ` ${unit}` : ''}`, detail].filter(Boolean).join(', ');
  return (
    <View style={[styles.tile, style]} accessible accessibilityLabel={spoken} testID={testID}>
      <AppText variant="overline" tone="muted" numberOfLines={1}>
        {label}
      </AppText>
      <View style={styles.valueRow}>
        <AppText variant="title" tone={tone} tabular numberOfLines={1} adjustsFontSizeToFit accessibilityRole="text">
          {value}
        </AppText>
        {unit ? (
          <AppText variant="label" tone="muted">
            {unit}
          </AppText>
        ) : null}
      </View>
      {detail ? (
        <AppText variant="caption" tone="faint" numberOfLines={2}>
          {detail}
        </AppText>
      ) : null}
    </View>
  );
}

/** Wrapping grid of StatTiles: tiles flex to ~2 per row on phones and 3–4 on wider screens. */
export function StatGrid({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.grid}>{children}</View>;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    tile: {
      flexGrow: 1,
      flexBasis: 140,
      minWidth: 130,
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      padding: t.space.md,
      gap: t.space.xxs,
    },
    valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: t.space.xs },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
  });
