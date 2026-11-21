/**
 * "End case" button that must be held for 1.5 s (accidental taps happen in a
 * busy theatre). A progress ring fills while held; a short tap only shows a
 * hint. Screen-reader users get an explicit "End case" accessibility action.
 *
 * Web: react-native-web supports neither long press from the keyboard nor
 * accessibility actions, so holding Space/Enter completes when the ring fills,
 * and a key press or an assistive-technology click (no pointer) calls
 * `onConfirmRequest` (the live screen asks "End the case now?").
 */
import { Platform, Pressable, StyleSheet, View, type AccessibilityActionEvent, type GestureResponderEvent } from 'react-native';

import { isKeyPress, useHoldToConfirm } from '@/hooks/useHoldToConfirm';
import { noTextSelect, useStyles, useTheme, withAlpha, type Theme } from '@/theme';

import { AppText } from '../AppText';
import { Icon } from '../Icon';
import { ProgressRing } from '../ProgressRing';

export const END_HOLD_MS = 1500;

export interface HoldToEndButtonProps {
  onConfirm: () => void;
  /** Called on a short tap (e.g. show "press and hold" hint). */
  onTap?: () => void;
  /** Web: activated by a key press or assistive technology rather than a held pointer (ask to confirm). */
  onConfirmRequest?: () => void;
  label?: string;
  disabled?: boolean;
  testID?: string;
}

/** Web: a press that did not come from a pointer — a key press, or a click from assistive technology (`detail` 0). */
export function isNonPointerActivation(event?: GestureResponderEvent): boolean {
  if (isKeyPress(event)) return true;
  const native = event?.nativeEvent as { detail?: unknown; type?: unknown } | undefined;
  return native?.type === 'click' && native.detail === 0;
}

export function HoldToEndButton({ onConfirm, onTap, onConfirmRequest, label = 'End case', disabled, testID }: HoldToEndButtonProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const { progress, handlers, confirm } = useHoldToConfirm(END_HOLD_MS, onConfirm);

  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (disabled) return;
    if (e.nativeEvent.actionName === 'longpress' || e.nativeEvent.actionName === 'endCase') confirm();
    else if (e.nativeEvent.actionName === 'activate') onTap?.();
  };

  const onPress = (event: GestureResponderEvent) => {
    if (Platform.OS === 'web' && onConfirmRequest && isNonPointerActivation(event)) onConfirmRequest();
    else onTap?.();
  };

  return (
    <Pressable
      {...handlers}
      onPress={disabled ? undefined : onPress}
      onLongPress={disabled ? undefined : handlers.onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Press and hold for one and a half seconds to end the case"
      accessibilityActions={[
        { name: 'activate' },
        { name: 'longpress', label },
        { name: 'endCase', label: `${label} now` },
      ]}
      onAccessibilityAction={onAccessibilityAction}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: pressed ? withAlpha(theme.colors.danger, theme.isDark ? 0.35 : 0.2) : theme.colors.dangerSoft },
        disabled ? styles.disabled : null,
      ]}
    >
      <ProgressRing progress={progress} size={44} strokeWidth={4} color={theme.colors.danger}>
        <Icon name="stop" size={18} color={theme.colors.danger} />
      </ProgressRing>
      <View style={styles.text}>
        <AppText variant="subheading" tone="danger">
          {label}
        </AppText>
        <AppText variant="caption" tone="muted">
          {progress > 0 && progress < 1 ? 'Keep holding…' : 'Press and hold'}
        </AppText>
      </View>
    </Pressable>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    button: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      minHeight: t.layout.bigTouch,
      paddingHorizontal: t.space.lg,
      paddingVertical: t.space.sm,
      borderRadius: t.radius.lg,
      borderWidth: 1.5,
      borderColor: t.colors.danger,
      ...noTextSelect,
    },
    text: { flex: 1 },
    disabled: { opacity: 0.45 },
  });
