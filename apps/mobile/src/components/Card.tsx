import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export type CardTone = 'default' | 'primary' | 'warning' | 'danger' | 'success';

export interface CardProps {
  children?: ReactNode;
  title?: string;
  subtitle?: string;
  icon?: IconName;
  /** Element rendered at the right of the header (e.g. a small button). */
  right?: ReactNode;
  tone?: CardTone;
  /** Makes the whole card pressable. */
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function toneColors(t: Theme, tone: CardTone): { bg: string; border: string; accent: string } {
  const c = t.colors;
  switch (tone) {
    case 'primary':
      return { bg: c.primarySoft, border: c.primary, accent: c.primary };
    case 'warning':
      return { bg: c.warningSoft, border: c.warning, accent: c.warning };
    case 'danger':
      return { bg: c.dangerSoft, border: c.danger, accent: c.danger };
    case 'success':
      return { bg: c.successSoft, border: c.success, accent: c.success };
    default:
      return { bg: c.surface, border: c.border, accent: c.textMuted };
  }
}

/** Surface container with optional header (title, subtitle, icon, right accessory). */
export function Card({
  children,
  title,
  subtitle,
  icon,
  right,
  tone = 'default',
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: CardProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const colors = toneColors(theme, tone);

  const header =
    title || subtitle || icon || right ? (
      <View style={styles.header}>
        {icon ? <Icon name={icon} size={20} color={colors.accent} /> : null}
        <View style={styles.headerText}>
          {title ? (
            <AppText variant="subheading" accessibilityRole="header">
              {title}
            </AppText>
          ) : null}
          {subtitle ? (
            <AppText variant="label" tone="muted">
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {right}
      </View>
    ) : null;

  const containerStyle = [styles.card, { backgroundColor: colors.bg, borderColor: colors.border }, style];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityHint={accessibilityHint}
        testID={testID}
        style={({ pressed }) => [containerStyle, pressed ? styles.pressed : null]}
      >
        {header}
        {children}
      </Pressable>
    );
  }
  return (
    <View style={containerStyle} testID={testID} accessibilityLabel={accessibilityLabel}>
      {header}
      {children}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    card: {
      borderRadius: t.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      padding: t.space.lg,
      gap: t.space.md,
    },
    pressed: { opacity: 0.85 },
    header: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    headerText: { flex: 1, gap: t.space.xxs },
  });
