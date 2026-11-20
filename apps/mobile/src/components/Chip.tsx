import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useStyles, useTheme, withAlpha, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export type ChipTone = 'neutral' | 'primary' | 'warning' | 'danger' | 'success';

export interface ChipProps {
  label: string;
  /** Selected (toggle chips). */
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  /** Small colour dot before the label (e.g. a phase colour). */
  dotColor?: string;
  tone?: ChipTone;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function toneColors(t: Theme, tone: ChipTone): { bg: string; fg: string; border: string } {
  const c = t.colors;
  switch (tone) {
    case 'primary':
      return { bg: c.primarySoft, fg: c.primary, border: withAlpha(c.primary, 0.4) };
    case 'warning':
      return { bg: c.warningSoft, fg: c.warning, border: withAlpha(c.warning, 0.4) };
    case 'danger':
      return { bg: c.dangerSoft, fg: c.danger, border: withAlpha(c.danger, 0.4) };
    case 'success':
      return { bg: c.successSoft, fg: c.success, border: withAlpha(c.success, 0.4) };
    default:
      return { bg: c.surfaceAlt, fg: c.textMuted, border: c.border };
  }
}

/** Compact label: a static tag, or a toggle/filter when `onPress` is given. */
export function Chip({ label, selected, onPress, icon, dotColor, tone = 'neutral', accessibilityLabel, style, testID }: ChipProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const colors = selected
    ? { bg: theme.colors.primary, fg: theme.colors.onPrimary, border: theme.colors.primary }
    : toneColors(theme, tone);

  const content = (
    <>
      {dotColor ? <View style={[styles.dot, { backgroundColor: dotColor }]} /> : null}
      {icon ? <Icon name={icon} size={14} color={colors.fg} /> : null}
      <AppText variant="label" color={colors.fg} numberOfLines={1}>
        {label}
      </AppText>
    </>
  );

  const base = [styles.chip, { backgroundColor: colors.bg, borderColor: colors.border }, style];

  if (!onPress) {
    return (
      <View style={base} testID={testID} accessible accessibilityLabel={accessibilityLabel ?? label}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      aria-selected={!!selected}
      hitSlop={6}
      testID={testID}
      style={({ pressed }) => [base, styles.interactive, pressed ? styles.pressed : null]}
    >
      {content}
    </Pressable>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: t.space.xs,
      paddingHorizontal: t.space.sm + 2,
      paddingVertical: t.space.xs,
      borderRadius: t.radius.pill,
      borderWidth: 1,
    },
    interactive: { minHeight: 36, paddingHorizontal: t.space.md },
    pressed: { opacity: 0.8 },
    dot: { width: 8, height: 8, borderRadius: 4 },
  });
