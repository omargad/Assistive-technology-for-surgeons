/**
 * Snackbar / toast with an optional action (e.g. "Undo") and a countdown bar
 * showing how long the action remains available. Positioned at the bottom of
 * its (relatively positioned) parent; announced politely to screen readers.
 */
import { useEffect, useRef } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useLatest } from '@/hooks/useLatest';
import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export interface ToastProps {
  visible: boolean;
  message: string;
  /** Changing the key restarts the timer (e.g. a new event id). */
  toastKey?: string | number;
  actionLabel?: string;
  onAction?: () => void;
  /** Called when the timer expires or the close button is pressed. */
  onDismiss?: () => void;
  /** Auto-dismiss after this many ms (0 = stays until dismissed). Default 4000. */
  durationMs?: number;
  showCountdown?: boolean;
  icon?: IconName;
  /** Distance from the bottom of the parent. */
  bottomOffset?: number;
  /** Large variant for the live screen. */
  large?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Toast({
  visible,
  message,
  toastKey,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = 4000,
  showCountdown,
  icon,
  bottomOffset = 16,
  large,
  style,
  testID,
}: ToastProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const progress = useRef(new Animated.Value(1)).current;
  const dismissRef = useLatest(onDismiss);

  useEffect(() => {
    if (!visible || durationMs <= 0) return undefined;
    progress.setValue(1);
    const anim = Animated.timing(progress, {
      toValue: 0,
      duration: durationMs,
      useNativeDriver: Platform.OS !== 'web',
    });
    if (showCountdown) anim.start();
    const timer = setTimeout(() => dismissRef.current?.(), durationMs);
    return () => {
      clearTimeout(timer);
      anim.stop();
    };
  }, [visible, durationMs, toastKey, showCountdown, progress, dismissRef]);

  if (!visible) return null;

  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: bottomOffset }]}>
      <View
        style={[styles.toast, large ? styles.large : null, style]}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        testID={testID}
      >
        <View style={styles.row}>
          {icon ? <Icon name={icon} size={large ? 22 : 18} color={theme.colors.onInverse} /> : null}
          <AppText variant={large ? 'bodyStrong' : 'label'} tone="inverse" style={styles.message} numberOfLines={3}>
            {message}
          </AppText>
          {actionLabel && onAction ? (
            <Pressable
              onPress={onAction}
              accessibilityRole="button"
              accessibilityLabel={actionLabel}
              hitSlop={8}
              style={({ pressed }) => [styles.action, large ? styles.actionLarge : null, pressed ? styles.pressed : null]}
              testID={testID ? `${testID}-action` : undefined}
            >
              <AppText variant={large ? 'subheading' : 'bodyStrong'} color={theme.colors.inverseAction}>
                {actionLabel}
              </AppText>
            </Pressable>
          ) : null}
          {onDismiss ? (
            <Pressable
              onPress={onDismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              hitSlop={8}
              style={styles.close}
            >
              <Icon name="close" size={18} color={theme.colors.onInverse} />
            </Pressable>
          ) : null}
        </View>
        {showCountdown && durationMs > 0 ? (
          <View style={styles.countdownTrack}>
            <Animated.View
              style={[styles.countdownFill, { transform: [{ scaleX: progress }] }, { transformOrigin: 'left' }]}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    host: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: t.space.lg },
    toast: {
      width: '100%',
      maxWidth: 560,
      backgroundColor: t.colors.inverse,
      borderRadius: t.radius.md,
      borderWidth: t.mode === 'or' ? 1 : 0,
      borderColor: t.colors.borderStrong,
      paddingVertical: t.space.sm,
      paddingHorizontal: t.space.md,
      gap: t.space.xs,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    large: { paddingVertical: t.space.md, paddingHorizontal: t.space.lg },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm, minHeight: 40 },
    message: { flex: 1 },
    action: { paddingHorizontal: t.space.md, paddingVertical: t.space.sm, borderRadius: t.radius.sm, minHeight: 44, justifyContent: 'center' },
    actionLarge: { paddingHorizontal: t.space.lg, minHeight: 56 },
    pressed: { opacity: 0.7 },
    close: { padding: t.space.xs },
    countdownTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(127,127,127,0.35)', overflow: 'hidden' },
    countdownFill: { height: '100%', backgroundColor: t.colors.inverseAction },
  });
