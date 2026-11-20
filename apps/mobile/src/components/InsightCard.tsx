import { StyleSheet, View } from 'react-native';

import { INSIGHT_KIND_LABELS } from '@surgeonpulse/core';
import type { Insight } from '@surgeonpulse/core';

import { useStyles, useTheme, withAlpha, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

const KIND_ICON: Record<Insight['kind'], IconName> = {
  info: 'bulb-outline',
  positive: 'trending-up',
  attention: 'eye-outline',
};

export interface InsightCardProps {
  insight: Insight;
  testID?: string;
}

/** Feedback card coloured by kind (observation / positive trend / worth a look). */
export function InsightCard({ insight, testID }: InsightCardProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const c = theme.colors;
  const accent = { info: c.info, positive: c.success, attention: c.warning }[insight.kind];
  const n = insight.evidence.length;
  return (
    <View
      style={[styles.card, { borderLeftColor: accent }]}
      accessible
      accessibilityLabel={`${INSIGHT_KIND_LABELS[insight.kind]}: ${insight.title}. ${insight.detail}`}
      testID={testID}
    >
      <View style={[styles.icon, { backgroundColor: withAlpha(accent, 0.15) }]}>
        <Icon name={KIND_ICON[insight.kind]} size={20} color={accent} />
      </View>
      <View style={styles.body}>
        <AppText variant="overline" color={accent}>
          {INSIGHT_KIND_LABELS[insight.kind]}
        </AppText>
        <AppText variant="bodyStrong">{insight.title}</AppText>
        <AppText variant="label" tone="muted">
          {insight.detail}
        </AppText>
        {n > 0 ? (
          <AppText variant="caption" tone="faint">
            Based on {n} session{n === 1 ? '' : 's'}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      gap: t.space.md,
      padding: t.space.lg,
      borderRadius: t.radius.lg,
      backgroundColor: t.colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      borderLeftWidth: 4,
    },
    icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, gap: 2 },
  });
