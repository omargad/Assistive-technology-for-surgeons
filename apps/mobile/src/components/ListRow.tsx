import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  /** Text value on the right (e.g. current setting). */
  value?: string;
  /** Custom right accessory (e.g. a Switch); replaces value/chevron. */
  right?: ReactNode;
  /** Extra content under the title (e.g. chips). */
  children?: ReactNode;
  onPress?: () => void;
  /** Shows a chevron (default: true when pressable). */
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Settings/history row with optional icon, subtitle, value and chevron. */
export function ListRow({
  title,
  subtitle,
  icon,
  iconColor,
  value,
  right,
  children,
  onPress,
  chevron,
  destructive,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ListRowProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const titleColor = destructive ? theme.colors.danger : theme.colors.text;
  const showChevron = chevron ?? (!!onPress && !right);

  const body = (
    <>
      {icon ? (
        <View style={styles.iconWrap}>
          <Icon name={icon} size={20} color={iconColor ?? (destructive ? theme.colors.danger : theme.colors.primary)} />
        </View>
      ) : null}
      <View style={styles.text}>
        <AppText variant="bodyStrong" color={titleColor} numberOfLines={2}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="label" tone="muted" numberOfLines={3}>
            {subtitle}
          </AppText>
        ) : null}
        {children}
      </View>
      {right ?? (value ? (
        <AppText variant="label" tone="muted" numberOfLines={1} style={styles.value}>
          {value}
        </AppText>
      ) : null)}
      {showChevron ? <Icon name="chevron-forward" size={18} color={theme.colors.textFaint} /> : null}
    </>
  );

  if (!onPress) {
    return (
      <View style={[styles.row, style]} testID={testID} accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, value, subtitle].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint}
      aria-disabled={!!disabled}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null, disabled ? styles.disabled : null, style]}
    >
      {body}
    </Pressable>
  );
}

/** Groups rows in a rounded surface with hairline separators. */
export function ListGroup({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.group, style]}>{children}</View>;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      minHeight: 56,
      paddingVertical: t.space.sm + 2,
      paddingHorizontal: t.space.lg,
      backgroundColor: t.colors.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.colors.border,
    },
    pressed: { backgroundColor: t.colors.surfaceAlt },
    disabled: { opacity: 0.45 },
    iconWrap: { width: 28, alignItems: 'center' },
    text: { flex: 1, gap: 2 },
    value: { maxWidth: '45%' },
    group: {
      borderRadius: t.radius.lg,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      backgroundColor: t.colors.surface,
    },
  });
