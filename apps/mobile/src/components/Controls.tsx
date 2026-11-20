/**
 * Small form controls: `SwitchRow` (labelled toggle), `Checkbox` and
 * `SectionHeader`.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export interface SwitchRowProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}

/** List row with a native Switch (accessible as a single switch control). */
export function SwitchRow({ title, subtitle, icon, value, onValueChange, disabled, testID }: SwitchRowProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.row}>
      {icon ? (
        <View style={styles.iconWrap}>
          <Icon name={icon} size={20} color={theme.colors.primary} />
        </View>
      ) : null}
      <View style={styles.text}>
        <AppText variant="bodyStrong">{title}</AppText>
        {subtitle ? (
          <AppText variant="label" tone="muted">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityHint={subtitle}
        trackColor={{ false: theme.colors.borderStrong, true: theme.colors.primary }}
        thumbColor={theme.colors.surface}
        ios_backgroundColor={theme.colors.borderStrong}
        testID={testID}
      />
    </View>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  accessibilityLabel: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Checkbox with a full-row touch target. */
export function Checkbox({ checked, onChange, label, accessibilityLabel, disabled, style, testID }: CheckboxProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={disabled ? undefined : () => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      aria-checked={checked}
      aria-disabled={!!disabled}
      testID={testID}
      style={({ pressed }) => [styles.checkRow, pressed ? styles.pressed : null, disabled ? styles.disabled : null, style]}
    >
      <Icon name={checked ? 'checkbox' : 'square-outline'} size={28} color={checked ? theme.colors.primary : theme.colors.borderStrong} />
      <View style={styles.text}>{typeof label === 'string' ? <AppText variant="body">{label}</AppText> : label}</View>
    </Pressable>
  );
}

export interface SectionHeaderProps {
  title: string;
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Overline-style section title for grouped content. */
export function SectionHeader({ title, action, style }: SectionHeaderProps) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.section, style]}>
      <AppText variant="overline" tone="muted" accessibilityRole="header" style={styles.text}>
        {title}
      </AppText>
      {action}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      minHeight: 56,
      paddingVertical: t.space.sm,
      paddingHorizontal: t.space.lg,
      backgroundColor: t.colors.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.colors.border,
    },
    iconWrap: { width: 28, alignItems: 'center' },
    text: { flex: 1, gap: 2 },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, minHeight: 48, paddingVertical: t.space.xs },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.45 },
    section: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm, marginTop: t.space.sm, paddingHorizontal: t.space.xs },
  });
