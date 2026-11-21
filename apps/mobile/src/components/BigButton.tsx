/**
 * Large live-screen button (≥ 64 pt) for phases and markers. Readable from a
 * distance and operable by a non-sterile team member in a hurry.
 */
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { noTextSelect, useStyles, useTheme, withAlpha, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export type BigButtonEmphasis = 'current' | 'next' | 'none';

export interface BigButtonProps {
  label: string;
  /** Small text under the label (e.g. "Next", "Hold to add a note"). */
  sublabel?: string;
  /** One-or-two-character glyph shown in a badge (e.g. core MARKER_ICONS). */
  glyph?: string;
  icon?: IconName;
  /** Accent colour (e.g. the phase colour). */
  accent?: string;
  emphasis?: BigButtonEmphasis;
  /** Label size: `large` (18 pt, default) or `medium` (16 pt) for long labels in narrow columns. */
  labelSize?: 'large' | 'medium';
  /** Receives the press event (on the web it carries modifier keys, e.g. Shift+Enter). */
  onPress?: (event: GestureResponderEvent) => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityActions?: readonly AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function BigButton({
  label,
  sublabel,
  glyph,
  icon,
  accent,
  emphasis = 'none',
  labelSize = 'large',
  onPress,
  onLongPress,
  delayLongPress,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  accessibilityActions,
  onAccessibilityAction,
  style,
  testID,
}: BigButtonProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const color = accent ?? theme.colors.primary;
  const current = emphasis === 'current';
  const next = emphasis === 'next';

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onLongPress={disabled ? undefined : onLongPress}
      delayLongPress={delayLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (sublabel ? `${label}, ${sublabel}` : label)}
      accessibilityHint={accessibilityHint}
      aria-selected={current}
      aria-disabled={!!disabled}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        {
          borderColor: current || next ? color : theme.colors.border,
          borderWidth: current || next ? 2 : 1,
          backgroundColor: current ? withAlpha(color, theme.isDark ? 0.28 : 0.16) : theme.colors.surface,
        },
        pressed ? { backgroundColor: withAlpha(color, theme.isDark ? 0.4 : 0.26) } : null,
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      <View style={[styles.stripe, { backgroundColor: color }]} />
      {glyph || icon ? (
        <View style={[styles.badge, { borderColor: color, backgroundColor: withAlpha(color, 0.18) }]}>
          {icon ? (
            <Icon name={icon} size={20} color={theme.colors.text} />
          ) : (
            <AppText variant="bodyStrong" maxFontSizeMultiplier={1.3}>
              {glyph}
            </AppText>
          )}
        </View>
      ) : null}
      <View style={styles.text}>
        <AppText variant={labelSize === 'large' ? 'subheading' : 'bodyStrong'} numberOfLines={2} maxFontSizeMultiplier={1.4}>
          {label}
        </AppText>
        {sublabel ? (
          <AppText variant="caption" tone="muted" numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {sublabel}
          </AppText>
        ) : null}
      </View>
      {current ? <Icon name="radio-button-on" size={22} color={color} /> : null}
      {next ? <Icon name="arrow-forward" size={20} color={color} /> : null}
    </Pressable>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    base: {
      minHeight: t.layout.bigTouch,
      borderRadius: t.radius.lg,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      paddingVertical: t.space.sm,
      paddingRight: t.space.md,
      paddingLeft: t.space.lg,
      overflow: 'hidden',
      ...noTextSelect,
    },
    stripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 6 },
    badge: {
      width: 30,
      height: 30,
      borderRadius: 15,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    text: { flex: 1, gap: 2 },
    disabled: { opacity: 0.45 },
  });
