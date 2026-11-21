/**
 * Snackbar / toast with an optional action (e.g. "Undo") and a countdown bar
 * showing how long the action remains available. Positioned at the bottom of
 * its (relatively positioned) parent, or — with `inline` — filling the space it
 * is given (the live screen reserves a fixed area for it so it never covers a
 * button). Announced politely to screen readers.
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
  /** Fill the parent instead of floating over the bottom of the screen. */
  inline?: boolean;
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
  inline,
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

  const body = (
      <View
        style={[styles.toast, large ? styles.large : null, inline ? styles.inline : null, style]}
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
              hitSlop={inline ? undefined : 8}
              style={({ pressed }) => [
                styles.action,
                large ? styles.actionLarge : null,
                inline ? styles.actionInline : null,
                pressed ? styles.pressed : null,
              ]}
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
              style={({ pressed }) => [styles.close, pressed ? styles.pressed : null]}
              testID={testID ? `${testID}-dismiss` : undefined}
            >
              <Icon name="close" size={18} color={theme.colors.onInverse} />
            </Pressable>
          ) : null}
        </View>
        {showCountdown && durationMs > 0 ? (
          <View style={[styles.countdownTrack, inline ? styles.countdownInline : null]}>
            <Animated.View
              style={[styles.countdownFill, { transform: [{ scaleX: progress }] }, { transformOrigin: 'left' }]}
            />
          </View>
        ) : null}
      </View>
  );

  if (inline) return body;
  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: bottomOffset }]}>
      {body}
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
    // Fills a fixed-height slot: no outer margin, vertical padding kept small, countdown on the bottom edge.
    inline: { maxWidth: undefined, flex: 1, justifyContent: 'center', paddingVertical: t.space.xs, paddingHorizontal: t.space.md, elevation: 0, shadowOpacity: 0 },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm, minHeight: 40 },
    message: { flex: 1 },
    action: { paddingHorizontal: t.space.md, paddingVertical: t.space.sm, borderRadius: t.radius.sm, minHeight: 44, justifyContent: 'center' },
    actionLarge: { paddingHorizontal: t.space.lg, minHeight: 56 },
    actionInline: { minHeight: t.layout.minTouch },
    pressed: { opacity: 0.7 },
    // 44 × 44 touch target (theme.layout.minTouch) around an 18-pt icon.
    close: { minWidth: t.layout.minTouch, minHeight: t.layout.minTouch, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.sm },
    countdownTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(127,127,127,0.35)', overflow: 'hidden' },
    countdownInline: { position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: 0 },
    countdownFill: { height: '100%', backgroundColor: t.colors.inverseAction },
  });
