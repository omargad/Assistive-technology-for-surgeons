import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityActions?: readonly AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function variantColors(t: Theme, variant: ButtonVariant): { bg: string; fg: string; border: string } {
  const c = t.colors;
  switch (variant) {
    case 'primary':
      return { bg: c.primary, fg: c.onPrimary, border: c.primary };
    case 'destructive':
      return { bg: c.danger, fg: c.onDanger, border: c.danger };
    case 'ghost':
      return { bg: 'transparent', fg: c.primary, border: 'transparent' };
    case 'secondary':
    default:
      return { bg: c.surface, fg: c.text, border: c.borderStrong };
  }
}

const HEIGHT: Record<ButtonSize, number> = { sm: 36, md: 48, lg: 56 };

/** Standard button (primary / secondary / destructive / ghost). */
export function Button({
  label,
  onPress,
  onLongPress,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  disabled,
  loading,
  fullWidth,
  accessibilityLabel,
  accessibilityHint,
  accessibilityActions,
  onAccessibilityAction,
  style,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const colors = variantColors(theme, variant);
  const inactive = disabled || loading;
  const textVariant = size === 'sm' ? 'label' : 'bodyStrong';
  const iconSize = size === 'sm' ? 16 : 20;

  return (
    <Pressable
      onPress={inactive ? undefined : onPress}
      onLongPress={inactive ? undefined : onLongPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      aria-disabled={!!inactive}
      aria-busy={!!loading}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      hitSlop={size === 'sm' ? 6 : undefined}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: Math.max(HEIGHT[size], size === 'sm' ? 36 : theme.layout.minTouch),
          backgroundColor: colors.bg,
          borderColor: colors.border,
          paddingHorizontal: size === 'sm' ? theme.space.md : theme.space.lg,
        },
        fullWidth ? styles.fullWidth : null,
        pressed && !inactive ? styles.pressed : null,
        inactive ? styles.disabled : null,
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator size="small" color={colors.fg} />
        ) : icon ? (
          <Icon name={icon} size={iconSize} color={colors.fg} />
        ) : null}
        <AppText variant={textVariant} color={colors.fg} numberOfLines={2} align="center">
          {label}
        </AppText>
        {iconRight ? <Icon name={iconRight} size={iconSize} color={colors.fg} /> : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    base: {
      borderRadius: t.radius.md,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: t.space.xs,
    },
    content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm },
    fullWidth: { alignSelf: 'stretch' },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.45 },
  });
