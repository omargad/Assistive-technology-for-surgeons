/** History-list row for one session with summary chips. */
import { Pressable, StyleSheet, View } from 'react-native';

import { APPROACH_LABELS, SESSION_STATUS_LABELS, formatDuration } from '@surgeonpulse/core';

import type { SessionListItem } from '@/services/storage/types';
import { formatDateTime, formatDelta, useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Chip } from './Chip';
import { Icon } from './Icon';

export interface SessionRowProps {
  item: SessionListItem;
  onPress?: () => void;
  testID?: string;
}

/** Chips summarising a session (mean HR, change from baseline, RMSSD, workload, status tags). */
export function sessionChips(item: SessionListItem): { label: string; tone: 'neutral' | 'primary' | 'warning' | 'danger' | 'success' }[] {
  const chips: { label: string; tone: 'neutral' | 'primary' | 'warning' | 'danger' | 'success' }[] = [];
  const s = item.summary;
  const status = item.meta.status;
  if (status !== 'completed') chips.push({ label: SESSION_STATUS_LABELS[status], tone: status === 'recording' ? 'warning' : 'danger' });
  if (s?.hr) chips.push({ label: `${Math.round(s.hr.mean)} bpm avg`, tone: 'neutral' });
  if (s?.meanHrDelta != null) chips.push({ label: `${formatDelta(s.meanHrDelta)} vs rest`, tone: 'primary' });
  if (s?.hrv) chips.push({ label: `RMSSD ${Math.round(s.hrv.rmssd)} ms`, tone: 'neutral' });
  const workload = s?.workload ? (s.workload.weighted ?? s.workload.raw) : null;
  if (workload != null) chips.push({ label: `Workload ${Math.round(workload)}`, tone: 'neutral' });
  const tags = item.meta.tags ?? [];
  if (tags.includes('demo')) chips.push({ label: 'Demo', tone: 'warning' });
  if (tags.some((t) => t.startsWith('uploaded:'))) chips.push({ label: 'Uploaded', tone: 'success' });
  return chips;
}

export function SessionRow({ item, onPress, testID }: SessionRowProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const { meta, summary } = item;
  const durationSec = summary?.durationSec ?? (meta.endedAt ? (meta.endedAt - meta.startedAt) / 1000 : null);
  const subtitle = [
    formatDateTime(meta.startedAt),
    durationSec != null ? formatDuration(durationSec) : null,
    meta.procedure.approach ? APPROACH_LABELS[meta.procedure.approach] : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const chips = sessionChips(item);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${meta.procedure.name}, ${subtitle}. ${chips.map((c) => c.label).join(', ')}`}
      accessibilityHint="Opens the session"
      testID={testID}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <View style={styles.text}>
        <AppText variant="bodyStrong" numberOfLines={2}>
          {meta.procedure.name}
        </AppText>
        <AppText variant="label" tone="muted">
          {subtitle}
        </AppText>
        {chips.length ? (
          <View style={styles.chips}>
            {chips.map((c) => (
              <Chip key={c.label} label={c.label} tone={c.tone} />
            ))}
          </View>
        ) : null}
      </View>
      <Icon name="chevron-forward" size={18} color={theme.colors.textFaint} />
    </Pressable>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      padding: t.space.lg,
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
    },
    pressed: { backgroundColor: t.colors.surfaceAlt },
    text: { flex: 1, gap: t.space.xs },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs, marginTop: t.space.xxs },
  });
